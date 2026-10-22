import { describe, expect, it } from "vitest"
import { generate } from "../src/core/index"
import { declaration, oas } from "./helpers/generate"
import { expectPassesTsc } from "./helpers/tsc"

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const post = (schema: unknown) => ({
  "/test": {
    post: {
      requestBody: { content: { "application/json": { schema } } },
      responses: { "200": { description: "OK", content: { "application/json": { schema } } } },
    },
  },
})

describe("directional branch scopes", () => {
  it.each(["readOnly", "writeOnly"] as const)(
    "relaxes referenced requirements at a %s use site",
    async (flag) => {
      const base = {
        type: "object",
        properties: {
          id: { type: "string" },
          nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
        required: ["id"],
      }
      const schemas = {
        Use: { allOf: [ref("Base"), { properties: { id: { [flag]: true } } }] },
        Base: base,
        Inline: { allOf: [base, { properties: { id: { [flag]: true } } }] },
      }
      const result = await generate(
        oas("3.0", {
          paths: post({ anyOf: [ref("Use"), ref("Inline")] }),
          components: { schemas },
        }),
      )
      expect(result.diagnostics).toStrictEqual([])
      expect(declaration(result.code, "Base")).toContain("id: string")
      const optional = flag === "readOnly" ? "Input" : ""
      const required = flag === "readOnly" ? "" : "Input"
      await expectPassesTsc(
        result.code,
        [
          'import type { Schemas } from "./file0"',
          ...["Use", "Inline"].flatMap((name) => [
            `const absent${name}: Schemas.${name}${optional} = {}`,
            `const present${name}: Schemas.${name}${required} = { id: "ok" }`,
            "// @ts-expect-error The opposite side still requires id.",
            `const missing${name}: Schemas.${name}${required} = {}`,
            "// @ts-expect-error Nested same-name properties retain requiredness.",
            `const nested${name}: Schemas.${name}${optional} = { nested: {} }`,
          ]),
          "// @ts-expect-error Shared declarations are unchanged.",
          "const base: Schemas.Base = {}",
        ].join("\n"),
      )
    },
  )

  it.each(["anyOf", "oneOf"] as const)(
    "keeps %s mixed annotation requirements inside their branches",
    async (keyword) => {
      const schemas = {
        Use: { required: ["id"], [keyword]: [ref("Read"), ref("Plain"), ref("Write")] },
        Read: {
          type: "object",
          properties: { kind: { const: "read" }, id: { type: "string", readOnly: true } },
          required: ["kind"],
        },
        Plain: {
          type: "object",
          properties: { kind: { const: "plain" }, id: { type: "number" } },
          required: ["kind"],
        },
        Write: {
          type: "object",
          properties: { kind: { const: "write" }, id: { type: "boolean", writeOnly: true } },
          required: ["kind"],
        },
      }
      const result = await generate(
        oas("3.0", { paths: post(ref("Use")), components: { schemas } }),
      )
      expect(result.diagnostics).toStrictEqual([])
      await expectPassesTsc(
        result.code,
        [
          'import type { Schemas } from "./file0"',
          'const read: Schemas.UseInput = { kind: "read" }',
          'const write: Schemas.Use = { kind: "write" }',
          ...["", "Input"].flatMap((side) => [
            `const plain${side}: Schemas.Use${side} = { kind: "plain", id: 1 }`,
            "// @ts-expect-error An unannotated branch still requires id.",
            `const missingPlain${side}: Schemas.Use${side} = { kind: "plain" }`,
          ]),
          "// @ts-expect-error Read-only is still required in responses.",
          'const missingRead: Schemas.Use = { kind: "read" }',
          "// @ts-expect-error Write-only is still required in requests.",
          'const missingWrite: Schemas.UseInput = { kind: "write" }',
        ].join("\n"),
      )
    },
  )
})

it.each([63, 64, 65])("bounds directional branch expansion at %i alternatives", async (count) => {
  const choices = Array.from({ length: count }, (_, index) => ({
    type: "object",
    properties: {
      kind: { const: index },
      id: { type: "string", ...(index % 2 === 0 ? { readOnly: true } : {}) },
    },
    required: ["kind"],
  }))
  const result = await generate(
    oas("3.1", {
      paths: post(ref("Use")),
      components: { schemas: { Use: { required: ["id"], anyOf: choices } } },
    }),
  )
  expect(result.diagnostics.map((d) => d.code)).toStrictEqual(
    count > 64 ? ["schema-precision-loss"] : [],
  )
  const message = expect.stringContaining("64 branch scopes")
  expect(result.diagnostics).toMatchObject(
    count > 64
      ? [
          {
            location: "#/components/schemas/Use",
            message,
          },
        ]
      : [],
  )
  await expectPassesTsc(
    result.code,
    [
      'import type { Schemas } from "./file0"',
      "const read: Schemas.UseInput = { kind: 0 }",
      'const plain: Schemas.UseInput = { kind: 1, id: "ok" }',
      "// @ts-expect-error Responses retain their requirement even when requests widen.",
      "const response: Schemas.Use = { kind: 0 }",
      count <= 64
        ? "// @ts-expect-error Plain branches retain their requirement within budget."
        : "// Beyond the budget this requirement is deliberately relaxed.",
      "const missing: Schemas.UseInput = { kind: 1 }",
      "// @ts-expect-error Widening retains unrelated branch constraints.",
      'const wrong: Schemas.UseInput = { kind: "wrong" }',
    ].join("\n"),
  )
})

it("preserves directional scopes across declaration order and external aliases", async () => {
  const read = {
    type: "object",
    properties: { kind: { const: "read" }, id: { type: "string", readOnly: true } },
    required: ["kind"],
  }
  const plain = {
    type: "object",
    properties: { kind: { const: "plain" }, id: { type: "number" } },
    required: ["kind"],
  }
  for (const external of [false, true]) {
    for (const reverse of [false, true]) {
      const schemas = {
        Use: { required: ["id"], anyOf: [ref("Alias"), plain] },
        Alias: external ? { $ref: "https://directions.test/read.json" } : ref("Read"),
        Read: read,
        Unknown: { type: "object", required: ["id"], anyOf: [true, ref("Alias")] },
      }
      // oxlint-disable-next-line no-await-in-loop -- keep the variant attached to its compiler result
      const result = await generate(
        oas("3.1", {
          paths: post({ anyOf: [ref("Use"), ref("Unknown")] }),
          components: {
            schemas: reverse ? Object.fromEntries(Object.entries(schemas).toReversed()) : schemas,
          },
        }),
        { base: "https://directions.test/api.json", load: () => Response.json(read) },
      )
      expect(result.diagnostics).toStrictEqual([])
      // oxlint-disable-next-line no-await-in-loop -- independent positive and negative witnesses per variant
      await expectPassesTsc(
        result.code,
        [
          'import type { Schemas } from "./file0"',
          'const read: Schemas.UseInput = { kind: "read" }',
          'const unknownRead: Schemas.UnknownInput = { kind: "read" }',
          "const unknownPlain: Schemas.Unknown = { id: 12 }",
          "// @ts-expect-error Plain branches still require id.",
          'const plain: Schemas.UseInput = { kind: "plain" }',
          "// @ts-expect-error Unknown alternatives do not absorb directional annotations.",
          'const response: Schemas.Unknown = { kind: "read" }',
          "// @ts-expect-error Shared declarations are unchanged.",
          'const shared: Schemas.Read = { kind: "plain" }',
        ].join("\n"),
      )
    }
  }
})

it.each(["readOnly", "writeOnly"] as const)(
  "retains %s after mixed-shape widening",
  async (flag) => {
    for (const count of [16, 17]) {
      for (const inline of [false, true]) {
        const annotated = {
          properties: { id: { type: "string", [flag]: true } },
          anyOf: [
            ...Array.from({ length: count - 1 }, (_, index) => ({ const: `s${index}` })),
            { type: "object", properties: { kind: { const: "object" } }, required: ["kind"] },
          ],
        }
        // oxlint-disable-next-line no-await-in-loop -- check each widening boundary independently
        const result = await generate(
          oas("3.1", {
            paths: post(ref("Use")),
            components: {
              schemas: {
                Use: {
                  type: "object",
                  required: ["id"],
                  allOf: [inline ? annotated : ref("Annotated")],
                },
                Annotated: annotated,
              },
            },
          }),
        )
        const optional = flag === "readOnly" ? "Input" : ""
        const required = flag === "readOnly" ? "" : "Input"
        // oxlint-disable-next-line no-await-in-loop -- retain both positive and negative witnesses
        await expectPassesTsc(
          result.code,
          [
            'import type { Schemas } from "./file0"',
            `const valid: Schemas.Use${optional} = { kind: "object" }`,
            "// @ts-expect-error The opposite direction retains requiredness.",
            `const missing: Schemas.Use${required} = { kind: "object" }`,
            "// @ts-expect-error Explicit constraints survive widening.",
            `const wrong: Schemas.Use${optional} = { kind: "wrong" }`,
            'const scalar: Schemas.Annotated = "s0"',
          ].join("\n"),
        )
      }
    }
  },
)

it.each(["readOnly", "writeOnly"] as const)(
  "retains %s when large unions widen to objects or unknown",
  async (flag) => {
    for (const mixed of [false, true]) {
      const annotated = { type: "object", properties: { id: { type: "string", [flag]: true } } }
      const alternatives = [
        annotated,
        ...Array.from({ length: 100 }, (_, index) =>
          mixed
            ? { const: `s${index}` }
            : { type: "object", properties: { value: { const: index } } },
        ),
      ]
      // oxlint-disable-next-line no-await-in-loop -- exercise both widening representations
      const result = await generate(
        oas("3.1", {
          paths: post(ref("Use")),
          components: {
            schemas: {
              Use: { type: "object", required: ["id"], allOf: [ref("Wide")] },
              Wide: {
                allOf: [
                  { anyOf: alternatives },
                  {
                    anyOf: Array.from({ length: 100 }, (_, index) => ({
                      type: "object",
                      properties: { kind: { const: index } },
                      required: ["kind"],
                    })),
                  },
                ],
              },
            },
          },
        }),
      )
      expect(result.diagnostics.map((d) => d.code)).toContain("schema-precision-loss")
      const optional = flag === "readOnly" ? "Input" : ""
      const required = flag === "readOnly" ? "" : "Input"
      // oxlint-disable-next-line no-await-in-loop -- retain constraints from the union that was not widened
      await expectPassesTsc(
        result.code,
        [
          'import type { Schemas } from "./file0"',
          `const valid: Schemas.Use${optional} = { kind: 0 }`,
          "// @ts-expect-error Opposite-direction requirements survive widening.",
          `const missing: Schemas.Use${required} = { kind: 0 }`,
          "// @ts-expect-error Unwidened union constraints survive.",
          `const wrong: Schemas.Use${optional} = { kind: 1000 }`,
        ].join("\n"),
      )
    }
  },
)
