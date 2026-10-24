import { describe, expect, it } from "vitest"
import type { DocumentLoader, GenerateOptions } from "../src/core/index"
import { generate } from "../src/core/index"
import { codes, declaration, gen, oas, typeOf, withSchemas } from "./helpers/generate"
import { expectPassesTsc, typecheck } from "./helpers/tsc"

/** Sixteen alternatives, each requiring one property. */
function group(n: number): Record<string, unknown> {
  return { anyOf: Array.from({ length: 16 }, (_, i) => ({ required: [`p${n}_${i}`] })) }
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

/** An object that requires one string property, `p`. */
const object = (p: string) => ({
  type: "object",
  required: [p],
  properties: { [p]: { type: "string" } },
})

const mixed = (count: number) => ({
  anyOf: [{ type: "string" }, ...Array.from({ length: count }, (_, i) => object(`p${i}`))],
})

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

describe("composition", () => {
  describe("composition", () => {
    it("merges allOf object members into one object", async () => {
      expect(
        await typeOf({
          allOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "number" }, a: { const: "x" } } },
          ],
        }),
      ).toBe('{\n  a: "x"\n  b?: number\n}')
    })

    it("intersects references and unions alternatives", async () => {
      const code = await gen(
        withSchemas("3.1", {
          Base: { type: "object", properties: { id: { type: "string" } } },
          Both: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              { type: "object", properties: { x: { type: "number" } } },
            ],
          },
          Either: { oneOf: [{ $ref: "#/components/schemas/Base" }, { type: "string" }] },
          Any: { anyOf: [{ type: "string" }, { type: "string" }, { type: "number" }] },
        }),
      )
      expect(declaration(code, "Both")).toBe("Base & { x?: number }")
      expect(declaration(code, "Either")).toBe("Base | string")
      expect(declaration(code, "Any")).toBe("string | number")
    })

    it("applies sibling keywords alongside applicators", async () => {
      expect(
        await typeOf({ type: "string", oneOf: [{ format: "email" }, { format: "uri" }] }),
      ).toBe("string")
      expect(
        await typeOf({
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          oneOf: [{ required: ["a"] }, { required: ["b"] }],
        }),
      ).toBe("{ a: string; b?: string } | { a?: string; b: string }")
    })

    it("treats $ref as an applicator: siblings are intersected", async () => {
      const code = await gen(
        withSchemas("3.1", {
          A: { type: "object", properties: { id: { type: "string" } } },
          Extended: {
            $ref: "#/components/schemas/A",
            properties: { more: { type: "boolean" } },
            description: "Annotated",
          },
          Alias: { $ref: "#/components/schemas/A", description: "Only annotations" },
        }),
      )
      expect(declaration(code, "Extended")).toBe("A & { more?: boolean }")
      expect(declaration(code, "Alias")).toBe("A")
    })

    it("keeps `not` only where it is exact", async () => {
      expect(await typeOf({ not: {} })).toBe("never")
      expect(await typeOf({ not: true })).toBe("never")
      // Excluding a type is not expressible; the wider type is still correct.
      expect(await typeOf({ type: ["string", "null"], not: { type: "null" } })).toBe(
        "string | null",
      )
    })

    it.each([
      [
        { if: { type: "string" }, then: { minLength: 1 }, else: { type: "number" } },
        "string | number",
      ],
      [{ if: { type: "string" }, else: { type: "number" } }, "string | number"],
      [{ if: { type: "string" }, then: { type: "string" } }, "unknown"],
      [
        {
          type: "object",
          properties: { kind: { type: "string" } },
          if: { properties: { kind: { const: "a" } } },
          then: { required: ["a"] },
          else: { required: ["b"] },
        },
        '{ kind?: "a"; a: unknown } | { kind?: string; b: unknown }',
      ],
    ])("if/then/else %j", async (schema, expected) => {
      expect(await typeOf(schema)).toBe(expected)
    })
  })

  describe("composition through references", () => {
    it("keeps scalar alternatives through referenced intersections and widening", async () => {
      const compound = {
        allOf: [
          { anyOf: [{ type: "string" }, object("a")] },
          { anyOf: [{ type: "string" }, object("b")] },
        ],
      }
      const { code, diagnostics } = await generate(
        withSchemas("3.1", {
          Early: { required: ["id"], allOf: [ref("Middle")] },
          Middle: { required: ["other"], allOf: [ref("Compound")] },
          Compound: compound,
          T: { required: ["id"], allOf: [ref("Compound")] },
          Inline: { required: ["id"], ...compound },
          // Both declaration orders must remain sound after Large widens to unknown.
          Before: { required: ["id"], allOf: [ref("Large")] },
          Large: { enum: Array.from({ length: 10001 }, (_, i) => `v${i}`) },
          After: { items: { type: "number" }, allOf: [ref("Large")] },
          Direct: {
            required: ["id"],
            enum: Array.from({ length: 10001 }, (_, i) => `v${i}`),
          },
          InlineLarge: {
            required: ["id"],
            allOf: [{ enum: Array.from({ length: 10001 }, (_, i) => `v${i}`) }],
          },
          Definite: { type: "object", required: ["id"], allOf: [ref("Compound")] },
        }),
      )
      expect(diagnostics.some((d) => d.code === "schema-precision-loss")).toBe(true)
      await expectPassesTsc(
        code,
        [
          'import type { Schemas } from "./file0"',
          'const referenced: Schemas.T = "allowed"',
          'const early: Schemas.Early = "allowed"',
          'const inline: Schemas.Inline = "allowed"',
          'const before: Schemas.Before = "v0"',
          'const after: Schemas.After = "v0"',
          'const direct: Schemas.Direct = "v0"',
          'const inlineLarge: Schemas.InlineLarge = "v0"',
          'const object: Schemas.Definite = { id: true, a: "a", b: "b" }',
          "// @ts-expect-error The referenced constraints still exclude numbers.",
          "const wrong: Schemas.T = 1",
          "// @ts-expect-error An explicit shape still applies.",
          'const scalar: Schemas.Definite = "wrong"',
          "// @ts-expect-error Explicit objects keep their required properties.",
          'const missing: Schemas.Definite = { a: "a", b: "b" }',
        ].join("\n"),
      )
    })

    it("preserves scalar alternatives beside implied shapes in literal unions", async () => {
      const code = await gen(
        withSchemas("3.1", {
          Objects: { enum: ["x", { b: 1 }, { c: 2 }] },
          T: { required: ["b"], allOf: [ref("Objects")] },
          Arrays: { enum: ["x", [1], ["wrong"]] },
          U: { items: { type: "number" }, allOf: [ref("Arrays")] },
        }),
      )
      await expectPassesTsc(
        code,
        [
          'import type { Schemas } from "./file0"',
          'const objects: Schemas.T[] = ["x", { b: 1 }, { b: 3, c: 2 }]',
          'const arrays: Schemas.U[] = ["x", [1]]',
          "// @ts-expect-error The object alternative still requires b.",
          "const missing: Schemas.T = { c: 2 }",
          "// @ts-expect-error The array alternative still constrains its items.",
          'const wrong: Schemas.U = ["wrong"]',
          "// @ts-expect-error Unlisted scalar values remain excluded.",
          'const scalar: Schemas.T = "other"',
        ].join("\n"),
      )
    })

    it("keeps referenced unions sound when implied-shape distribution exceeds its budget", async () => {
      const { code, diagnostics } = await generate(
        withSchemas("3.1", {
          Large: mixed(16),
          Small: mixed(4),
          T: { required: ["b"], allOf: [ref("Large")] },
          U: { required: ["b"], allOf: [ref("Small"), mixed(5)] },
          Objects: { anyOf: Array.from({ length: 17 }, (_, i) => ({ required: [`p${i}`] })) },
          V: { required: ["b"], allOf: [ref("Objects")] },
        }),
      )
      expect(
        diagnostics.map(({ code: diagnosticCode, location }) => ({
          code: diagnosticCode,
          location,
        })),
      ).toStrictEqual([{ code: "schema-precision-loss", location: "#/components/schemas/T" }])
      expect(code.length).toBeLessThan(5000)
      await expectPassesTsc(
        code,
        [
          'import type { Schemas } from "./file0"',
          'const large: Schemas.T = "valid"',
          'const product: Schemas.U = "valid"',
          "// @ts-expect-error Widening must retain the original union constraints.",
          "const wrong: Schemas.T = { b: 1 }",
          "const object: Schemas.V = { b: 1, p0: true }",
          "// @ts-expect-error Object-only unions still keep implied object requirements.",
          "const missing: Schemas.V = { p0: true }",
        ].join("\n"),
      )
    })

    it("lets an implied shape give way to a referenced union", async () => {
      const code = await gen(
        withSchemas("3.1", {
          S: { type: ["string", "null"] },
          T: { allOf: [ref("S"), { properties: { a: { type: "integer" } } }] },
          U: { anyOf: [{ type: "string" }, { type: "object" }] },
          V: { allOf: [ref("U"), { items: { type: "integer" } }] },
          A: { type: "string" },
          W: { oneOf: [ref("A"), { type: "null" }], required: ["x"] },
        }),
      )
      await expectPassesTsc(
        code,
        [
          'import type { Schemas } from "./file0"',
          'export const t: Schemas.T[] = ["abc", null]',
          'export const v: Schemas.V[] = ["abc", { x: 1 }]',
          'export const w: Schemas.W[] = ["abc", null]',
        ].join("\n"),
      )
    })

    it("widens intersections of referenced unions that would be too large for TypeScript", async () => {
      const schemas: Record<string, unknown> = {}
      for (let u = 0; u < 6; u++) {
        schemas[`U${u}`] = {
          anyOf: Array.from({ length: 10 }, (_, i) => ({
            type: "object",
            required: [`u${u}_${i}`],
            properties: { [`u${u}_${i}`]: { type: "string" } },
          })),
        }
      }
      schemas.T = { allOf: Array.from({ length: 6 }, (_, u) => ref(`U${u}`)) }
      const code = await gen(withSchemas("3.1", schemas))
      await expectPassesTsc(
        code,
        'import type { Schemas } from "./file0"\nexport const t: Schemas.T = { u0_0: "a", u1_0: "a", u2_0: "a", u3_0: "a", u4_0: "a", u5_0: "a" }\n',
      )
    })

    it("counts unions inside referenced intersections, too", async () => {
      const schemas: Record<string, unknown> = {}
      for (let u = 0; u < 6; u++) {
        for (let i = 0; i < 10; i++) {
          schemas[`V${u}_${i}`] = {
            type: "object",
            required: [`v${u}_${i}`],
            properties: { [`v${u}_${i}`]: { type: "string" } },
          }
        }
        schemas[`U${u}`] = {
          type: "object",
          properties: { [`p${u}`]: { type: "string" } },
          oneOf: Array.from({ length: 10 }, (_, i) => ref(`V${u}_${i}`)),
        }
      }
      schemas.T = { allOf: Array.from({ length: 6 }, (_, u) => ref(`U${u}`)) }
      const code = await gen(withSchemas("3.1", schemas))
      await expectPassesTsc(
        code,
        'import type { Schemas } from "./file0"\nexport const t: Schemas.T = { v0_0: "a", v1_0: "a", v2_0: "a", v3_0: "a", v4_0: "a", v5_0: "a" }\n',
      )
    })

    it("counts a union each time an intersection reaches it", async () => {
      const schemas: Record<string, unknown> = {}
      for (const u of ["U0", "U1"]) {
        for (let i = 0; i < 20; i++) schemas[`${u}_${i}`] = object(`${u.toLowerCase()}_${i}`)
        schemas[u] = { oneOf: Array.from({ length: 20 }, (_, i) => ref(`${u}_${i}`)) }
      }
      for (let i = 0; i < 24; i++) schemas[`Z_${i}`] = object(`z_${i}`)
      schemas.Z = { oneOf: Array.from({ length: 24 }, (_, i) => ref(`Z_${i}`)) }
      schemas.X = {
        oneOf: Array.from({ length: 12 }, (_, k) => ({
          allOf: [ref("U0"), ref("U1"), { properties: { [`x${k}`]: { type: "string" } } }],
        })),
      }
      schemas.T = { allOf: [ref("X"), ref("Z")] }
      const code = await gen(withSchemas("3.1", schemas))
      await expectPassesTsc(
        code,
        'import type { Schemas } from "./file0"\nexport const t: Schemas.T = { u0_0: "a", u1_0: "a", z_0: "a" }\n',
      )
    })

    it("names a schema referenced again, so output grows with the input", async () => {
      const lib: Record<string, unknown> = {}
      const depth = 24
      for (let i = 0; i < depth; i++) {
        lib[`a${i}`] = {
          type: "object",
          properties: { p: { $ref: `#/x-lib/a${i + 1}` }, q: { $ref: `#/x-lib/a${i + 1}` } },
        }
      }
      lib[`a${depth}`] = { type: "string" }
      const doc = withSchemas("3.1", { Root: { $ref: "#/x-lib/a0" } })
      doc["x-lib"] = lib
      const code = await gen(doc)
      expect(code.length).toBeLessThan(20_000)
      await expectPassesTsc(code)
    })
  })

  describe("bounded composition", () => {
    it("keeps intersections of many alternatives compact", async () => {
      const code = await gen(
        withSchemas("3.1", {
          X: {
            type: "object",
            properties: { a: { type: "string" } },
            allOf: [1, 2, 3, 4, 5].map((n) => group(n)),
          },
        }),
      )
      expect(code.length).toBeLessThan(20_000)
      await expectPassesTsc(code)
    })

    it("distributes a union over a shape implied by keywords", async () => {
      expect(
        await typeOf({ allOf: [{ type: ["string", "array"] }, { items: { type: "number" } }] }),
      ).toBe("string | number[]")
    })

    it("reports empty applicators", async () => {
      const result = await generate(withSchemas("3.1", { E: { anyOf: [] } }))
      expect(declaration(result.code, "E")).toBe("never")
      expect(codes(result.diagnostics)).toStrictEqual([
        "invalid-schema #/components/schemas/E/anyOf",
      ])
    })
  })
})

describe("composition matrix", () => {
  it("preserves mixed composition witnesses across orders, reference locations and alias depths", async () => {
    const cases: CompositionCase[] = []
    for (const count of [15, 16, 17]) {
      for (const placement of placements) {
        for (const order of orders) {
          const fixture = graph(placement)
          const alternatives = fixture.place("Alternatives", {
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
          const objectConstraint = fixture.place("ObjectConstraint", {
            type: "object",
            required: ["guard"],
            properties: { guard: { type: "boolean" } },
          })
          const array = fixture.place("ArrayConstraint", {
            type: "array",
            items: { enum: [1, 2] },
          })
          const scalar = fixture.place("ScalarConstraint", { enum: ["s0", "absent"] })
          const restriction = fixture.place("Restriction", {
            anyOf: [objectConstraint, array, scalar],
          })
          Object.assign(fixture.schemas, {
            Mixed: alternatives,
            Object: { allOf: [alternatives, objectConstraint] },
            Array: { allOf: [alternatives, array] },
            Scalar: { allOf: [alternatives, scalar] },
            IntersectionOfUnions: { allOf: [alternatives, restriction] },
            UnionOfIntersections: {
              anyOf: [objectConstraint, array, scalar].map((constraint) => ({
                allOf: [alternatives, constraint],
              })),
            },
            ImpliedObject: { required: ["guard"], allOf: [alternatives] },
            ImpliedArray: { items: { enum: [1, 2] }, allOf: [alternatives] },
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
})

describe("patterns", () => {
  it("evaluates patterns as JavaScript can, staying wide when it cannot", async () => {
    expect(
      await typeOf({
        type: "object",
        patternProperties: { "^x\\-": { type: "string" } },
        additionalProperties: false,
        required: ["x-a"],
      }),
    ).toBe('{\n  "x-a": string\n  [key: string]: string\n}')
    expect(
      await typeOf({ type: "object", patternProperties: { "(?<!a)b": {} }, required: ["ab"] }),
    ).toBe("{\n  ab: unknown\n  [key: string]: unknown\n}")
  })

  it("applies a member's patterns only to the properties they match", async () => {
    expect(
      await typeOf({
        allOf: [
          { patternProperties: { "^x": { type: "string" } } },
          { properties: { b: { type: "number" }, xb: { type: "number" } } },
        ],
      }),
    ).toBe("{\n  b?: number\n  xb?: never\n  [key: string]: string | number | undefined\n}")
  })

  it("stops a pathological pattern match and can generate again after the timeout", async () => {
    const hostile = oas("3.1", {
      components: {
        schemas: {
          Slow: {
            type: "object",
            required: [`${"a".repeat(26)}!`],
            patternProperties: { "^(a+)+$": { type: "string" } },
          },
        },
      },
    })
    await expect(generate(hostile)).rejects.toMatchObject({
      name: "GenerateError",
      diagnostics: [
        {
          severity: "error",
          code: "invalid-document",
          location: "#",
          message: expect.stringContaining("patternProperties match exceeded"),
        },
      ],
    })
    const result = await generate(
      oas("3.1", {
        components: {
          schemas: {
            Fast: {
              type: "object",
              required: ["x-id"],
              patternProperties: { "(?<=x-)id$": { type: "number" } },
            },
          },
        },
      }),
    )
    expect(result.code).toContain('"x-id": number')
    expect(result.diagnostics).toStrictEqual([])
  })

  it("also bounds pattern matching when merging allOf properties", async () => {
    await expect(
      generate(
        oas("3.1", {
          components: {
            schemas: {
              Slow: {
                allOf: [
                  { type: "object", properties: { [`${"a".repeat(26)}!`]: { type: "string" } } },
                  { patternProperties: { "^(a+)+$": { type: "string" } } },
                ],
              },
            },
          },
        }),
      ),
    ).rejects.toThrow("patternProperties match exceeded")
  })
})
