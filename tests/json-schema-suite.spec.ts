import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generate } from "../src/core/index"
import { documentSource } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"
import { typecheck } from "./helpers/tsc"

/**
 * Soundness against the official JSON Schema Test Suite: every instance the suite marks valid must
 * be assignable to the generated type. (Invalid instances may still be assignable: TypeScript
 * cannot express every constraint, and the generator widens rather than guesses.)
 *
 * Each schema is served as its own document, so `#`-relative references resolve inside it, exactly
 * as in the suite.
 */

const DIR = join(import.meta.dirname, "fixtures/json-schema-test-suite")

interface Group {
  description: string
  schema: unknown
  tests: Array<{ description: string; data: unknown; valid: boolean }>
}

/** Offline resources retain their original retrieval URIs and reference bases. */
const REMOTES = join(DIR, "remotes")
const SOURCES = JSON.parse(readFileSync(join(REMOTES, "sources.json"), "utf8")) as Record<
  string,
  { file: string; source: string; sha256: string }
>

/**
 * Valid instances knowingly rejected, with the reason. Each is a documented approximation (see
 * docs/openapi.md, "Approximations").
 */
const SHAPE = "Shape keywords without `type` are read as implying that shape"
const ABSENT = "Properties a schema does not mention are assumed absent"
const DYNAMIC = "$dynamicRef is resolved statically"
const PROTOTYPE = "TypeScript compares these names with Object.prototype members"
const KNOWN: Record<string, string> = {
  "additionalProperties.json / additionalProperties being false does not allow other properties / ignores arrays":
    SHAPE,
  "additionalProperties.json / additionalProperties being false does not allow other properties / ignores strings":
    SHAPE,
  "additionalProperties.json / additionalProperties being false does not allow other properties / ignores other non-objects":
    SHAPE,
  "items.json / a schema given for items / ignores non-arrays": SHAPE,
  "items.json / a schema given for items / JavaScript pseudo-array is valid": SHAPE,
  "patternProperties.json / patternProperties validates properties matching a regex / ignores arrays":
    SHAPE,
  "patternProperties.json / patternProperties validates properties matching a regex / ignores strings":
    SHAPE,
  "patternProperties.json / patternProperties validates properties matching a regex / ignores other non-objects":
    SHAPE,
  "prefixItems.json / a schema given for prefixItems / JavaScript pseudo-array is valid": SHAPE,
  "properties.json / object properties validation / ignores arrays": SHAPE,
  "properties.json / object properties validation / ignores other non-objects": SHAPE,
  "properties.json / properties whose names are Javascript object property names / ignores arrays":
    SHAPE,
  "properties.json / properties whose names are Javascript object property names / ignores other non-objects":
    SHAPE,
  "ref.json / root pointer ref / match": SHAPE,
  "ref.json / root pointer ref / recursive match": SHAPE,
  "ref.json / simple URN base URI with $ref via the URN / valid under the URN IDed schema": SHAPE,
  "required.json / required validation / ignores arrays": SHAPE,
  "required.json / required validation / ignores strings": SHAPE,
  "required.json / required validation / ignores other non-objects": SHAPE,
  "required.json / required validation / ignores null": SHAPE,
  "required.json / required validation / ignores boolean": SHAPE,
  "required.json / required properties whose names are Javascript object property names / ignores arrays":
    SHAPE,
  "required.json / required properties whose names are Javascript object property names / ignores other non-objects":
    SHAPE,
  "dependentSchemas.json / dependent subschema incompatible with root / matches dependency": ABSENT,
  "dependentSchemas.json / dependent subschema incompatible with root / no dependency": ABSENT,
  "not.json / forbidden property / property absent": ABSENT,
  "patternProperties.json / regexes are not anchored by default and are case sensitive / regexes are case sensitive":
    ABSENT,
  "properties.json / object properties validation / doesn't invalidate other properties": ABSENT,
  "dynamicRef.json / A $dynamicRef that initially resolves to a schema with a matching $dynamicAnchor resolves to the first $dynamicAnchor in the dynamic scope / The recursive part is valid against the root":
    DYNAMIC,
  "dynamicRef.json / A $dynamicRef that initially resolves to a schema without a matching $dynamicAnchor behaves like a normal $ref to $anchor / The recursive part doesn't need to validate against the root":
    DYNAMIC,
  "properties.json / properties whose names are Javascript object property names / none of the properties mentioned":
    PROTOTYPE,
}

describe("JSON Schema Test Suite (draft 2020-12)", () => {
  it("rejects invalid instances for constraints TypeScript can express", async () => {
    // Explicit groups: integer precision, object exactness and validation-only constraints
    // cannot be tested as if TypeScript were a JSON Schema validator.
    const exact = new Set([
      "type.json / number type matches numbers",
      "type.json / string type matches strings",
      "type.json / array type matches arrays",
      "type.json / boolean type matches booleans",
      "type.json / null type matches only the null object",
      "type.json / type as array with one item",
      "const.json / const validation",
      "const.json / const with null",
      "const.json / const with false does not match 0",
      "const.json / const with true does not match 1",
      "const.json / nul characters in strings",
      "const.json / characters with the same visual representation but different codepoint",
      "const.json / characters with the same visual representation, but different number of codepoints",
      "enum.json / simple enum validation",
      "enum.json / heterogeneous enum-with-null validation",
      "enum.json / enum with escaped characters",
      "enum.json / empty enum",
      "required.json / required validation",
      "required.json / required with escaped characters",
      "items.json / items with boolean schema (false)",
      "items.json / prefixItems with no additional items allowed",
      "items.json / items with heterogeneous array",
      "prefixItems.json / prefixItems with boolean schemas",
      "boolean_schema.json / boolean schema 'false'",
    ])
    const schemas: Record<string, unknown> = {}
    const checks: string[] = []
    const found = new Set<string>()
    for (const file of readdirSync(DIR)
      .filter((name) => name.endsWith(".json"))
      .toSorted()) {
      const groups = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Group[]
      for (const group of groups) {
        const id = `${file} / ${group.description}`
        if (!exact.has(id)) continue
        found.add(id)
        const name = `S${found.size}`
        schemas[name] = group.schema
        for (const test of group.tests) {
          if (test.valid) continue
          checks.push(
            `export const c${checks.length}: [${literalType(test.data)}] extends [Schemas.${name}] ? false : true = true // ${id} / ${test.description}`,
          )
        }
      }
    }
    expect(found).toStrictEqual(exact)
    expect(checks.length).toBeGreaterThan(0)
    const { code, diagnostics } = await generate({
      openapi: "3.1.0",
      info: { title: "Representable constraints", version: "1" },
      components: { schemas },
    })
    expect(diagnostics).toStrictEqual([])
    expect(
      await typecheck({
        "api.ts": code,
        "checks.ts": `import type { Schemas } from "./api"\n${checks.join("\n")}`,
      }),
    ).toBe("")
  })

  it("accepts every valid instance", { timeout: 120_000 }, async () => {
    const files: Record<string, unknown> = {}
    const checks: Array<{ id: string; schema: number; type: string }> = []
    const groups = readdirSync(DIR)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) =>
        (JSON.parse(readFileSync(join(DIR, file), "utf8")) as Group[]).map((group) => ({
          file,
          group,
        })),
      )

    groups.forEach(({ file, group }, index) => {
      files[`s${index}.json`] = group.schema
      for (const test of group.tests) {
        if (!test.valid) continue
        checks.push({
          id: `${file} / ${group.description} / ${test.description}`,
          schema: index,
          type: literalType(test.data),
        })
      }
    })

    const schemas = Object.fromEntries(groups.map((_, i) => [`S${i}`, { $ref: `s${i}.json` }]))
    const doc = {
      openapi: "3.1.0",
      info: { title: "suite", version: "1" },
      components: { schemas },
    }
    const code = await withFiles(files as Record<string, object>, async (dir) => {
      const result = await generate(
        ...documentSource(doc, join(dir, "openapi.json"), {
          loader: (uri) => {
            if (uri.startsWith("file:")) return undefined
            const source = SOURCES[uri]
            if (!source) throw new Error(`Unmapped suite resource: ${uri}`)
            return new Response(readFileSync(join(REMOTES, source.file), "utf8"), {
              headers: { "content-type": "application/schema+json" },
            })
          },
        }),
      )
      return result.code
    })

    const lines = checks.map(
      (check, i) =>
        `export const c${i}: [${check.type}] extends [Schemas.S${check.schema}] ? true : false = true`,
    )
    const output = await typecheck({
      "api.ts": code,
      "checks.ts": `import type { Schemas } from "./api.js"\n${lines.join("\n")}\n`,
    })

    const failing = new Set<string>()
    for (const match of output.matchAll(/^checks\.ts\((\d+),/gm)) {
      failing.add(checks[Number(match[1]) - 2].id)
    }
    const unexpected = [...failing].filter((id) => !(id in KNOWN))
    expect({
      unexpected,
      otherErrors: output.split("\n").filter((l) => l !== "" && !l.startsWith("checks.ts(")),
    }).toStrictEqual({
      unexpected: [],
      otherErrors: [],
    })
    expect(checks.length).toBeGreaterThan(0)
  })
})

/** The exact TypeScript type of a JSON value. */
function literalType(value: unknown): string {
  if (value === null || typeof value === "boolean") return String(value)
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "number"
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => literalType(v)).join(", ")}]`
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `${JSON.stringify(k)}: ${literalType(v)}`,
  )
  return `{ ${entries.join("; ")} }`
}
