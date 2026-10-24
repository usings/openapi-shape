import { describe, expect, it } from "vitest"
import { generate } from "../src/core/index"
import { codes, declaration, gen, typeOf, withSchemas } from "./helpers/generate"
import { expectPassesTsc } from "./helpers/tsc"

// OpenAPI 3.1 and 3.2 Schema Objects are JSON Schema 2020-12.

/** A union of a string and an object whose `p0` is an implied shape over `next`. */
function level(next: string) {
  return {
    anyOf: [
      {
        type: "object",
        properties: {
          p0: { required: ["b"], allOf: [{ $ref: `#/components/schemas/${next}` }] },
        },
      },
      { type: "string" },
    ],
  }
}

describe("schema values", () => {
  describe("values", () => {
    it.each([
      [true, "unknown"],
      [false, "never"],
      [{}, "unknown"],
      [{ description: "only annotations" }, "unknown"],
      [{ type: "string" }, "string"],
      [{ type: "integer" }, "number"],
      [{ type: "number" }, "number"],
      [{ type: "boolean" }, "boolean"],
      [{ type: "null" }, "null"],
      [{ type: ["string", "null"] }, "string | null"],
      [{ type: ["integer", "string"] }, "number | string"],
      [{ type: [] }, "never"],
    ])("%j → %s", async (schema, expected) => {
      expect(await typeOf(schema)).toBe(expected)
    })

    it.each([
      [{ const: "a" }, '"a"'],
      [{ const: null }, "null"],
      [{ const: { "kind": "x", "n-1": [1, true] } }, '{ kind: "x"; "n-1": [1, true] }'],
      [{ enum: ["a", 1, null, false] }, '"a" | 1 | null | false'],
      [{ enum: [true, false] }, "boolean"],
      [{ enum: ["a", "a"] }, '"a"'],
      [{ enum: [] }, "never"],
      // `type` and `enum`/`const` both apply: values of other types are impossible.
      [{ type: "string", enum: ["a", 1, null] }, '"a"'],
      [{ type: ["string", "null"], enum: ["a", null] }, '"a" | null'],
      [{ type: "integer", enum: [1, 1.5] }, "1"],
      [{ type: "string", const: 1 }, "never"],
      [{ const: "a", enum: ["a", "b"] }, '"a"'],
      [{ const: "c", enum: ["a", "b"] }, "never"],
    ])("%j → %s", async (schema, expected) => {
      expect(await typeOf(schema)).toBe(expected)
    })

    it("keeps formats as documentation and projects binary values as JSON strings", async () => {
      const result = await generate(
        withSchemas("3.1", {
          T: {
            type: "object",
            properties: {
              at: { type: "string", format: "date-time" },
              file: { type: "string", format: "binary" },
            },
          },
        }),
      )
      expect(declaration(result.code, "T")).toBe(
        "{\n  /** @format date-time */\n  at?: string\n  /** @format binary */\n  file?: string\n}",
      )
      expect(result.diagnostics).toStrictEqual([])
    })
  })

  describe("arrays", () => {
    it.each([
      [{ type: "array", items: { type: "string" } }, "string[]"],
      [{ type: "array" }, "unknown[]"],
      [
        { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        "(string | number)[]",
      ],
      [{ type: "array", items: false }, "[]"],
      // prefixItems constrain only the elements that exist; minItems makes them required.
      [
        { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
        "[string?, number?, ...unknown[]]",
      ],
      [
        {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
          minItems: 1,
          items: false,
        },
        "[string, number?]",
      ],
      [
        {
          type: "array",
          prefixItems: [{ type: "string" }],
          minItems: 1,
          items: { type: "boolean" },
        },
        "[string, ...boolean[]]",
      ],
      // The pre-2020-12 tuple form is unambiguous, so it is read as one.
      [
        { type: "array", items: [{ type: "string" }], additionalItems: false, minItems: 1 },
        "[string]",
      ],
    ])("%j → %s", async (schema, expected) => {
      expect(await typeOf(schema)).toBe(expected)
    })
  })

  describe("objects", () => {
    it("types declared and required properties", async () => {
      const type = await typeOf({
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" } },
        required: ["id", "extra"],
      })
      expect(type).toBe("{\n  id: number\n  name?: string\n  extra: unknown\n}")
    })

    it("types undeclared required properties from patternProperties or additionalProperties", async () => {
      expect(
        await typeOf({
          type: "object",
          required: ["x-a", "b"],
          patternProperties: { "^x-": { type: "string" } },
          additionalProperties: { type: "number" },
        }),
      ).toBe('{\n  "x-a": string\n  b: number\n  [key: string]: string | number\n}')
      expect(await typeOf({ type: "object", required: ["a"], additionalProperties: false })).toBe(
        "{\n  a: never\n}",
      )
    })

    it.each([
      [{ type: "object" }, "{\n  [key: string]: unknown\n}"],
      [{ type: "object", additionalProperties: true }, "{\n  [key: string]: unknown\n}"],
      [
        { type: "object", additionalProperties: { type: "string" } },
        "{\n  [key: string]: string\n}",
      ],
      [
        { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
        "{\n  a?: string\n}",
      ],
      // An index signature must admit every declared property, including absent optional ones.
      [
        {
          type: "object",
          properties: { a: { type: "boolean" } },
          additionalProperties: { type: "string" },
        },
        "{\n  a?: boolean\n  [key: string]: string | boolean | undefined\n}",
      ],
    ])("%j", async (schema, expected) => {
      expect(await typeOf(schema)).toBe(expected)
    })

    it("quotes property names that are not identifiers", async () => {
      expect(
        await typeOf({
          type: "object",
          properties: {
            "user-id": { type: "string" },
            "2fa": { type: "boolean" },
            "$ok": { type: "null" },
          },
        }),
      ).toBe('{\n  "user-id"?: string\n  "2fa"?: boolean\n  $ok?: null\n}')
    })

    it("infers objects and arrays from shape keywords, only for values of that shape", async () => {
      expect(await typeOf({ properties: { a: { type: "string" } } })).toBe("{\n  a?: string\n}")
      expect(await typeOf({ items: { type: "string" } })).toBe("string[]")
      // `properties` does not constrain strings, so the string survives.
      expect(
        await typeOf({ type: "string", allOf: [{ properties: { a: { type: "number" } } }] }),
      ).toBe("string")
      expect(await typeOf({ allOf: [{ type: "array" }, { properties: { a: {} } }] })).toBe(
        "unknown[]",
      )
    })
  })
})

describe("OpenAPI compatibility", () => {
  // OpenAPI 3.0 Schema Objects: an extended subset of JSON Schema Wright-00.

  describe("nullable: the schema also admits null", () => {
    it.each([
      [{ type: "string", nullable: true }, "string | null"],
      [
        { type: "object", nullable: true, properties: { a: { type: "integer" } } },
        "{ a?: number } | null",
      ],
      [{ type: "string", nullable: true, enum: ["a", null] }, '"a" | null'],
      [{ type: "string", nullable: false }, "string"],
    ])("%j → %s", async (schema, expected) => {
      expect(await typeOf(schema, "3.0")).toBe(expected)
    })

    it("admits null where 3.0.3+ would not", async () => {
      const result = await generate(
        withSchemas("3.0", {
          Base: { type: "object", properties: { id: { type: "string" } } },
          NoType: { nullable: true, allOf: [{ $ref: "#/components/schemas/Base" }] },
          Enum: { type: "string", nullable: true, enum: ["a", "b"] },
          AllOf: { type: "object", nullable: true, allOf: [{ $ref: "#/components/schemas/Base" }] },
          Ref: { $ref: "#/components/schemas/Base", nullable: true },
          Unconstrained: { nullable: true },
        }),
      )
      expect(declaration(result.code, "NoType")).toBe("Base | null")
      expect(declaration(result.code, "Enum")).toBe('"a" | "b" | null')
      expect(declaration(result.code, "AllOf")).toBe("Base | null")
      expect(declaration(result.code, "Ref")).toBe("Base | null")
      expect(declaration(result.code, "Unconstrained")).toBe("unknown")
      expect(result.diagnostics).toStrictEqual([])
      await expectPassesTsc(result.code)
    })
  })

  describe("3.0 keyword set", () => {
    it("applies keywords next to $ref, which 3.0 would ignore", async () => {
      const result = await generate(
        withSchemas("3.0", {
          Base: { type: "object", properties: { id: { type: "string" } } },
          Extended: {
            $ref: "#/components/schemas/Base",
            properties: { extra: { type: "boolean" } },
            description: "Shown, too",
          },
          Annotated: { $ref: "#/components/schemas/Base", description: "only an annotation" },
        }),
      )
      expect(declaration(result.code, "Extended")).toBe("Base & { extra?: boolean }")
      expect(result.code).toContain("/** Shown, too */\n  export type Extended")
      expect(declaration(result.code, "Annotated")).toBe("Base")
      expect(result.diagnostics).toStrictEqual([])
    })

    it.each([
      {
        keyword: "const, prefixItems, and patternProperties",
        schema: {
          type: "object",
          properties: {
            kind: { type: "string", const: "x" },
            pair: {
              type: "array",
              prefixItems: [{ type: "string" }],
              minItems: 1,
              items: { type: "number" },
            },
          },
          patternProperties: { "^x-": { type: "string" } },
        },
        expected:
          '{\n  kind?: "x"\n  /** @minItems 1 */\n  pair?: [string, ...number[]]\n  [key: string]: string | [string, ...number[]] | undefined\n}',
      },
      { keyword: "type arrays", schema: { type: ["string", "null"] }, expected: "string | null" },
      { keyword: "type: null", schema: { type: "null" }, expected: "null" },
      {
        keyword: "tuple items and additionalItems",
        schema: { type: "array", items: [{ type: "string" }], additionalItems: false },
        expected: "[string?]",
      },
      { keyword: "items: false", schema: { type: "array", items: false }, expected: "[]" },
      {
        keyword: "boolean property schemas",
        schema: { type: "object", properties: { a: false } },
        expected: "{\n  a?: never\n}",
      },
    ])("applies $keyword in 3.0", async ({ schema, expected }) => {
      const result = await generate(withSchemas("3.0", { T: schema }))
      expect(declaration(result.code, "T")).toBe(expected)
      expect(result.diagnostics).toStrictEqual([])
    })

    it("projects binary and base64 schemas as JSON strings", async () => {
      expect(await typeOf({ type: "string", format: "binary" }, "3.0")).toBe("string")
      expect(await typeOf({ type: "string", format: "byte" }, "3.0")).toBe("string")
    })

    it("renders boolean exclusive bounds as exclusive constraints", async () => {
      const code = await gen(
        withSchemas("3.0", {
          T: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 1 },
        }),
      )
      expect(code).toContain("/**\n   * @exclusiveMinimum 0\n   * @maximum 1\n   */")
    })
  })

  it("follows Swagger-era and removed keywords where documents still use them", async () => {
    const result = await generate(
      withSchemas("3.1", {
        A: { type: "file" },
        B: { type: "string", nullable: true },
        C: { type: "date" },
      }),
    )
    expect(declaration(result.code, "A")).toBe("string")
    expect(declaration(result.code, "B")).toBe("string | null")
    expect(declaration(result.code, "C")).toBe("unknown")
    expect(codes(result.diagnostics)).toStrictEqual(["invalid-schema #/components/schemas/C/type"])
  })
})

describe("declarations", () => {
  describe("references and names", () => {
    it("names $defs targets and recursive schemas", async () => {
      const code = await gen(
        withSchemas("3.1", {
          Tree: {
            type: "object",
            properties: {
              children: { type: "array", items: { $ref: "#/components/schemas/Tree" } },
              meta: { $ref: "#/components/schemas/Tree/$defs/Meta" },
            },
            $defs: { Meta: { type: "object", properties: { size: { type: "integer" } } } },
          },
        }),
      )
      expect(declaration(code, "Tree")).toBe("{\n  children?: Tree[]\n  meta?: Meta\n}")
      expect(declaration(code, "Meta")).toBe("{\n  size?: number\n}")
      await expectPassesTsc(code)
    })

    it("inlines plain pointer targets, naming them only to break recursion", async () => {
      const code = await gen(
        withSchemas("3.1", {
          A: {
            type: "object",
            properties: {
              copy: { $ref: "#/components/schemas/A/properties/inner" },
              inner: {
                type: "object",
                properties: { next: { $ref: "#/components/schemas/A/properties/inner" } },
              },
            },
          },
        }),
      )
      expect(declaration(code, "A")).toBe("{\n  copy?: A_inner\n  inner?: { next?: A_inner }\n}")
      expect(declaration(code, "A_inner")).toBe("{\n  next?: A_inner\n}")
      await expectPassesTsc(code)
    })

    it("resolves $id and $anchor within schema resources", async () => {
      const code = await gen(
        withSchemas("3.1", {
          Wrapper: {
            $id: "https://example.com/schemas/wrapper",
            type: "object",
            properties: {
              a: { $ref: "#item" },
              b: { $ref: "https://example.com/schemas/item.json" },
            },
            $defs: {
              Item: { $anchor: "item", type: "string" },
              Other: { $id: "item.json", type: "number" },
            },
          },
        }),
      )
      // A $defs key names its schema even when the schema has its own $id.
      expect(declaration(code, "Wrapper")).toBe("{\n  a?: Item\n  b?: Other\n}")
      expect(declaration(code, "Other")).toBe("number")
    })

    it("sanitizes names and reports collisions", async () => {
      const result = await generate(
        withSchemas("3.1", {
          "User-Profile": { type: "string" },
          "User.Profile": { type: "number" },
          "class": { type: "boolean" },
          "用户": { type: "null" },
        }),
      )
      expect(result.code).toContain("export type User_Profile = string")
      expect(result.code).toContain("export type User_Profile2 = number")
      expect(result.code).toContain("export type _class = boolean")
      expect(result.code).toContain("export type 用户 = null")
      expect(codes(result.diagnostics)).toStrictEqual([
        "renamed-schema #/components/schemas/User.Profile",
      ])
      await expectPassesTsc(result.code)
    })

    it("approximates $dynamicRef statically", async () => {
      const result = await generate(
        withSchemas("3.1", {
          A: {
            $dynamicAnchor: "node",
            type: "object",
            properties: { next: { $dynamicRef: "#node" } },
          },
        }),
      )
      expect(declaration(result.code, "A")).toBe("{\n  next?: A\n}")
      expect(result.diagnostics).toStrictEqual([])
    })

    it("breaks cycles that only pass through unions and intersections", async () => {
      const result = await generate(
        withSchemas("3.1", {
          Pet: {
            type: "object",
            required: ["petType"],
            properties: { petType: { type: "string" }, name: { type: "string" } },
            oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
          },
          Cat: {
            allOf: [
              { $ref: "#/components/schemas/Pet" },
              { type: "object", properties: { purrs: { type: "boolean" } } },
            ],
          },
          Dog: {
            allOf: [
              { $ref: "#/components/schemas/Pet" },
              { type: "object", properties: { barks: { type: "boolean" } } },
            ],
          },
        }),
      )
      expect(declaration(result.code, "Cat")).toBe(
        "{\n  petType: string\n  name?: string\n  purrs?: boolean\n}",
      )
      expect(codes(result.diagnostics)).toStrictEqual([
        "circular-schema #/components/schemas/Cat",
        "circular-schema #/components/schemas/Dog",
      ])
      await expectPassesTsc(result.code)
    })

    it("labels tuples whose optional or rest items hold arrays, so that they may recur", async () => {
      const result = await generate(
        withSchemas("3.1", {
          // Unlabelled, TypeScript would resolve `[B[]?]` at once (TS2456).
          A: {
            anyOf: [
              { type: "string" },
              {
                type: "array",
                prefixItems: [{ type: "array", items: { $ref: "#/components/schemas/B" } }],
                items: false,
              },
            ],
          },
          B: { anyOf: [{ $ref: "#/components/schemas/A" }, { type: "number" }] },
          // A rest item that refers back directly is deferred.
          Expr: {
            anyOf: [
              { type: "string" },
              {
                type: "array",
                prefixItems: [{ type: "string" }],
                minItems: 1,
                items: { $ref: "#/components/schemas/Expr" },
              },
            ],
          },
        }),
      )
      expect(declaration(result.code, "A")).toBe("string | [_0?: B[]]")
      expect(declaration(result.code, "B")).toBe("A | number")
      expect(declaration(result.code, "Expr")).toBe("string | [string, ...Expr[]]")
      expect(result.diagnostics).toStrictEqual([])
      await expectPassesTsc(result.code)
    })

    it("labels a recursive tuple whose other elements name no type alias", async () => {
      const code = await gen(
        withSchemas("3.1", {
          D1: {
            anyOf: [
              { type: "number" },
              {
                type: "array",
                prefixItems: [
                  { type: "string", format: "date-time" },
                  { type: "array", items: { $ref: "#/components/schemas/D1" } },
                ],
                minItems: 1,
                items: false,
              },
            ],
          },
        }),
      )
      // `string` names no type alias, so TypeScript would not defer the tuple.
      expect(declaration(code, "D1")).toBe("number | [_0: string, _1?: D1[]]")
      await expectPassesTsc(code)
    })

    it("expands a recursive union an implied shape meets once on the way down", async () => {
      const code = await gen(
        withSchemas("3.1", {
          S: {
            anyOf: [
              {
                type: "object",
                properties: {
                  a: { properties: { b: {} }, allOf: [{ $ref: "#/components/schemas/S" }] },
                },
              },
              { type: "string" },
            ],
          },
        }),
      )
      // Below the first level, the type widens to either side.
      expect(declaration(code, "S")).toBe(
        "{ a?: { b?: unknown; a?: { b?: unknown } | S } | string } | string",
      )
      await expectPassesTsc(code)
    })

    it("widens only unions it would have looked through that mix objects with other values", async () => {
      const code = await gen(
        withSchemas("3.1", {
          S0: level("S1"),
          S1: {
            anyOf: [
              {
                type: "object",
                properties: {
                  // A definite shape: the implied one gives way, exactly.
                  p0: { required: ["b"], allOf: [{ $ref: "#/components/schemas/E" }] },
                },
              },
              { type: "string" },
            ],
          },
          E: { enum: ["a", "b"] },
          // Too large to look through at any level: kept as it was.
          Top: {
            allOf: [
              { required: ["b"] },
              { $ref: "#/components/schemas/T" },
              { $ref: "#/components/schemas/Big" },
            ],
          },
          T: {
            anyOf: [
              { type: "object", required: ["t"], properties: { t: { const: 1 } } },
              { type: "integer" },
            ],
          },
          Big: {
            anyOf: [
              ...Array.from({ length: 17 }, (_, i) => ({
                type: "object",
                required: ["kind"],
                properties: { kind: { const: `k${i}` } },
              })),
              { type: "integer" },
            ],
          },
        }),
      )
      expect(declaration(code, "S0")).toBe("{ p0?: { b: unknown; p0?: E } | string } | string")
      expect(declaration(code, "Top")).toBe("({ b: unknown; t: 1 } & Big) | (Big & number)")
      await expectPassesTsc(code)
    })

    it("widens below the first level, rather than shut out what the schema allows", async () => {
      const code = await gen(
        withSchemas("3.1", {
          S0: level("S1"),
          S1: level("S2"),
          S2: { anyOf: [{ type: "object" }, { type: "string" }] },
        }),
      )
      await expectPassesTsc(
        code,
        'import type { Schemas } from "./file0"\nexport const valid: Schemas.S0 = { p0: { b: 1, p0: "str" } }',
      )
    })

    it("looks through referenced unions one level deep, so alternatives cannot multiply", async () => {
      // Each union's members hold an implied shape over the next union, in a cycle.
      const schemas = Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `S${i}`,
          {
            anyOf: [
              ...[0, 1, 2, 3].map((p) => ({
                type: "object",
                properties: {
                  [`p${p}`]: {
                    properties: { b: {} },
                    allOf: [{ $ref: `#/components/schemas/S${(i + 1) % 6}` }],
                  },
                },
              })),
              { type: "string" },
            ],
          },
        ]),
      )
      const code = await gen(withSchemas("3.1", schemas))
      expect(code.length).toBeLessThan(20_000)
      await expectPassesTsc(code)
    })

    it("documents schemas with their constraints", async () => {
      const code = await gen(
        withSchemas("3.1", {
          T: {
            title: "Title",
            description: "Line one\nline two with */ inside",
            deprecated: true,
            type: "integer",
            minimum: 1,
            exclusiveMaximum: 10,
            default: 5,
            externalDocs: { url: "https://example.com", description: "More" },
          },
        }),
      )
      expect(code).toContain(
        [
          "  /**",
          "   * Title",
          "   *",
          "   * Line one",
          "   * line two with *\\/ inside",
          "   *",
          "   * @deprecated",
          "   * @default 5",
          "   * @minimum 1",
          "   * @exclusiveMaximum 10",
          "   * @see https://example.com More",
          "   */",
          "  export type T = number",
        ].join("\n"),
      )
    })
  })

  describe("declaration stability", () => {
    it("does not depend on the order components are declared in", async () => {
      const pet = {
        oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
        discriminator: { propertyName: "petType" },
      }
      const cat = {
        type: "object",
        properties: {
          petType: { enum: ["cat"] },
          friends: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
        },
      }
      const dog = { type: "object", properties: { petType: { enum: ["dog"] } } }
      const array = { type: "array", items: { $ref: "#/components/schemas/A" } }
      const holder = {
        properties: { p: { allOf: [{ $ref: "#/components/schemas/B" }, { required: ["k"] }] } },
      }
      const first = await gen(
        withSchemas("3.1", { Cat: cat, Pet: pet, Dog: dog, B: array, A: holder }),
      )
      const second = await gen(
        withSchemas("3.1", { Pet: pet, Dog: dog, Cat: cat, A: holder, B: array }),
      )
      for (const code of [first, second]) {
        expect(declaration(code, "Pet")).toBe("Cat | Dog")
        // A `required` without `type` constrains objects only, and B is an array.
        expect(declaration(code, "A")).toBe("{\n  p?: B\n}")
      }
    })

    it("names schemas with identifiers every TypeScript version accepts", async () => {
      // A letter added in Unicode 16, which TypeScript does not know.
      const recent = String.fromCodePoint(0x10d50)
      const code = await gen(
        withSchemas("3.1", {
          [`${recent}x`]: {
            type: "object",
            properties: { [recent]: { type: "string" }, 名前: { type: "string" } },
          },
        }),
      )
      expect(code).toContain("export interface _x {")
      expect(code).toContain(`${JSON.stringify(recent)}?: string`)
      expect(code).toContain("名前?: string")
      await expectPassesTsc(code)
    })
  })

  it("does not throw on a malformed escape in an $id", async () => {
    const code = await gen(
      withSchemas("3.1", {
        A: { properties: { b: { $ref: "https://example.com/a%zz.json" } } },
        B: { properties: { c: { $id: "https://example.com/a%zz.json", type: "string" } } },
      }),
    )
    expect(declaration(code, "A")).toBe("{\n  b?: a_zz\n}")
  })
})
