import { expect, it } from "vitest"
import type { DocumentLoader, GenerateOptions } from "../src/core/index"
import { generate } from "../src/core/index"
import { withSchemas } from "./helpers/generate"
import { typecheck } from "./helpers/tsc"

type Schema = Record<string, unknown>
type Order = "forward" | "reverse" | "rotated"
interface Placement {
  kind: "inline" | "local" | "external"
  depth: number
}
interface CompositionCase {
  name: string
  schemas: Record<string, Schema>
  options: GenerateOptions
  checks: string[]
  precisionLoss?: boolean
}

const placements: Placement[] = [
  { kind: "inline", depth: 0 },
  { kind: "local", depth: 0 },
  { kind: "local", depth: 2 },
  { kind: "external", depth: 0 },
  { kind: "external", depth: 2 },
]
const orders: Order[] = ["forward", "reverse", "rotated"]

function ordered(schemas: Record<string, Schema>, order: Order): Record<string, Schema> {
  const entries = Object.entries(schemas)
  if (order === "reverse") entries.reverse()
  if (order === "rotated") entries.push(...entries.splice(0, Math.floor(entries.length / 2)))
  return Object.fromEntries(entries)
}

/** Each external alias lives in its own resource, exercising relative references too. */
function graph(placement: Placement) {
  const schemas: Record<string, Schema> = {}
  const resources = new Map<string, Schema>()
  const load: DocumentLoader = (uri) => {
    const schema = resources.get(uri)
    if (!schema) throw new Error(`Unexpected invariant resource: ${uri}`)
    return Response.json(schema)
  }
  function place(name: string, schema: Schema): Schema {
    if (placement.kind === "inline") return schema
    let target = schema
    for (let depth = 0; depth <= placement.depth; depth++) {
      const key = `${name}${depth}`
      if (placement.kind === "local") {
        schemas[key] = target
        target = { $ref: `#/components/schemas/${key}` }
      } else {
        resources.set(`https://invariants.test/${key}.json`, target)
        target = { $ref: `${key}.json` }
      }
    }
    return target
  }
  return { schemas, place, options: { base: "https://invariants.test/api.json", load } }
}

/**
 * Test structural assignability of concrete JSON value types, not fresh-literal excess-property
 * checks. Negatives therefore exercise constraints even when the value comes from a variable.
 */
function witnesses(
  schema: string,
  allowed: Record<string, unknown>,
  rejected: Record<string, unknown>,
): string {
  return [
    ...Object.entries(allowed).map(
      ([name, value]) =>
        `export type ${schema}_allows_${name} = Assert<[${JSON.stringify(value)}] extends [S.${schema}] ? true : false>`,
    ),
    ...Object.entries(rejected).map(
      ([name, value]) =>
        `export type ${schema}_rejects_${name} = Assert<[${JSON.stringify(value)}] extends [S.${schema}] ? false : true>`,
    ),
  ].join("\n")
}

function consumer(module: string, checks: string[]): string {
  return `import type { Schemas as S } from "./${module}"
type Assert<T extends true> = T
${checks.join("\n")}
`
}

async function checkCases(cases: CompositionCase[]): Promise<string> {
  const modules = await Promise.all(
    cases.map(async ({ name, schemas, options, checks, precisionLoss }) => {
      const output = await generate(withSchemas("3.1", schemas), options)
      expect({ name, codes: new Set(output.diagnostics.map((d) => d.code)) }).toStrictEqual({
        name,
        codes: new Set(precisionLoss ? ["schema-precision-loss"] : []),
      })
      return [
        [`${name}.ts`, output.code],
        [`${name}_use.ts`, consumer(name, checks)],
      ]
    }),
  )
  return typecheck(Object.fromEntries(modules.flat()), {
    compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true },
  })
}

it("preserves mixed composition witnesses across orders, reference locations and alias depths", async () => {
  const cases: CompositionCase[] = []
  for (const count of [15, 16, 17]) {
    for (const placement of placements) {
      for (const order of orders) {
        const fixture = graph(placement)
        const mixed = fixture.place("Alternatives", {
          anyOf: [
            ...Array.from({ length: count - 2 }, (_, i) => ({ const: `s${i}` })),
            {
              type: "object",
              required: ["kind", "payload"],
              properties: { kind: { const: "record" }, payload: { type: "number" } },
            },
            { type: "array", items: { type: "number" } },
          ],
        })
        const object = fixture.place("ObjectConstraint", {
          type: "object",
          required: ["guard"],
          properties: { guard: { type: "boolean" } },
        })
        const array = fixture.place("ArrayConstraint", {
          type: "array",
          items: { enum: [1, 2] },
        })
        const scalar = fixture.place("ScalarConstraint", { enum: ["s0", "absent"] })
        const restriction = fixture.place("Restriction", { anyOf: [object, array, scalar] })
        Object.assign(fixture.schemas, {
          Mixed: mixed,
          Object: { allOf: [mixed, object] },
          Array: { allOf: [mixed, array] },
          Scalar: { allOf: [mixed, scalar] },
          IntersectionOfUnions: { allOf: [mixed, restriction] },
          UnionOfIntersections: {
            anyOf: [object, array, scalar].map((constraint) => ({ allOf: [mixed, constraint] })),
          },
          ImpliedObject: { required: ["guard"], allOf: [mixed] },
          ImpliedArray: { items: { enum: [1, 2] }, allOf: [mixed] },
        })
        const name = `mixed_${count}_${placement.kind}_${placement.depth}_${order}`
        const record = { kind: "record", payload: 7 }
        const guarded = { ...record, guard: true }
        const invalid = {
          boolean: true,
          null: null,
          number: 7,
          unlistedString: "absent",
          missingPayload: { kind: "record", guard: true },
          wrongPayload: { kind: "record", payload: "wrong", guard: true },
          wrongKind: { kind: "other", payload: 7, guard: true },
          missingKind: { payload: 7, guard: true },
          wrongItems: ["wrong"],
        }
        const constrainedAllowed = { scalar: "s0", object: guarded, array: [1, 2], empty: [] }
        const constrainedRejected = {
          ...invalid,
          excludedString: "s1",
          missingGuard: record,
          wrongGuard: { ...record, guard: "wrong" },
          excludedItem: [3],
        }
        const checks = [
          witnesses(
            "Mixed",
            {
              ...Object.fromEntries(
                Array.from({ length: count - 2 }, (_, i) => [`s${i}`, `s${i}`]),
              ),
              object: record,
              array: [1, 3],
              empty: [],
            },
            invalid,
          ),
          witnesses(
            "Object",
            { record: guarded },
            { ...constrainedRejected, scalar: "s0", array: [1, 2], empty: [] },
          ),
          witnesses(
            "Array",
            { array: [1, 2], empty: [] },
            { ...constrainedRejected, scalar: "s0", object: guarded },
          ),
          witnesses(
            "Scalar",
            { scalar: "s0" },
            { ...constrainedRejected, object: guarded, array: [1, 2], empty: [] },
          ),
          witnesses("IntersectionOfUnions", constrainedAllowed, constrainedRejected),
          witnesses("UnionOfIntersections", constrainedAllowed, constrainedRejected),
          // Implied keywords may lose precision at the distribution limit; the mixed union's
          // own representable constraints and its allowed non-object/non-array values survive.
          witnesses("ImpliedObject", constrainedAllowed, invalid),
          witnesses("ImpliedArray", constrainedAllowed, invalid),
        ]
        cases.push({
          name,
          schemas: ordered(fixture.schemas, order),
          options: fixture.options,
          precisionLoss: count > 16,
          checks,
        })
      }
    }
  }
  // One compiler process for all 45 variants, including negative witnesses for every variant.
  expect(await checkCases(cases)).toBe("")
})

it("retains witnesses and explicit constraints at expansion products 9999, 10000 and 10001", async () => {
  const cases: CompositionCase[] = []
  // Exact products, using two modest unions rather than ten thousand input branches.
  for (const [leftCount, rightCount] of [
    [99, 101],
    [100, 100],
    [73, 137],
  ]) {
    for (const order of ["forward", "reverse"] as const) {
      const fixture = graph({ kind: "local", depth: 2 })
      const alternatives = (key: string, count: number) =>
        fixture.place(key, {
          anyOf: Array.from({ length: count }, (_, i) => ({
            type: "object",
            required: [key],
            properties: { [key]: { const: i } },
          })),
        })
      const leftUnion = alternatives("left", leftCount)
      const rightUnion = alternatives("right", rightCount)
      fixture.schemas.Product = {
        type: "object",
        required: ["guard", "left", "right"],
        properties: {
          guard: { type: "boolean" },
          left: { type: "number" },
          right: { type: "number" },
        },
        allOf: [leftUnion, { allOf: [rightUnion] }],
      }
      const product = leftCount * rightCount
      const name = `product_${product}_${order}`
      const allowed: Record<string, unknown> = {}
      for (const left of [0, Math.floor(leftCount / 2), leftCount - 1]) {
        for (const right of [0, Math.floor(rightCount / 2), rightCount - 1]) {
          allowed[`left${left}_right${right}`] = { guard: true, left, right }
        }
      }
      const rejected: Record<string, unknown> = {
        scalar: "wrong",
        array: [],
        missingGuard: { left: 0, right: 0 },
        wrongGuard: { guard: "wrong", left: 0, right: 0 },
        missingLeft: { guard: true, right: 0 },
        missingRight: { guard: true, left: 0 },
        wrongLeftType: { guard: true, left: "wrong", right: 0 },
        wrongRightType: { guard: true, left: 0, right: "wrong" },
      }
      // Above the documented budget, union membership may widen. Explicit outer constraints
      // must still hold; at and below it both complete finite domains remain enforceable.
      if (product <= 10_000) {
        rejected.leftBelow = { guard: true, left: -1, right: 0 }
        rejected.leftAbove = { guard: true, left: leftCount, right: 0 }
        rejected.rightBelow = { guard: true, left: 0, right: -1 }
        rejected.rightAbove = { guard: true, left: 0, right: rightCount }
      }
      cases.push({
        name,
        schemas: ordered(fixture.schemas, order),
        options: fixture.options,
        precisionLoss: product > 10_000,
        checks: [witnesses("Product", allowed, rejected)],
      })
    }
  }
  expect(await checkCases(cases)).toBe("")
})
