import { describe, expect, it } from "vitest"
import { generate } from "../src/core/index"
import { codes, declaration, entry, gen, oas, typeOf, withSchemas } from "./helpers/generate"
import { expectPassesTsc } from "./helpers/tsc"

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

  it("reads format: binary as raw bytes, a Blob, and format: byte as base64 text", async () => {
    expect(await typeOf({ type: "string", format: "binary" }, "3.0")).toBe("Blob")
    expect(await typeOf({ type: "string", format: "byte" }, "3.0")).toBe("string")
  })

  it("renders boolean exclusive bounds as exclusive constraints", async () => {
    const code = await gen(
      withSchemas("3.0", { T: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 1 } }),
    )
    expect(code).toContain("/**\n   * @exclusiveMinimum 0\n   * @maximum 1\n   */")
  })
})

const readWriteDoc = (version: "3.0" | "3.1") =>
  oas(version, {
    paths: {
      "/users": {
        post: {
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Team" } } },
          },
          responses: {
            "201": {
              description: "Created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Team" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        User: {
          type: "object",
          required: ["id", "name", "password"],
          properties: {
            id: { type: "string", readOnly: true },
            name: { type: "string" },
            password: { type: "string", writeOnly: true },
          },
        },
        Team: { type: "object", properties: { lead: { $ref: "#/components/schemas/User" } } },
        Unused: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", readOnly: true } },
        },
      },
    },
  })

describe("readOnly and writeOnly: `required` applies to one side only", () => {
  it("emits request-side variants where requiredness differs, transitively", async () => {
    const code = await gen(readWriteDoc("3.0"))
    expect(declaration(code, "User")).toBe(
      "{\n  /** @readOnly */\n  id: string\n  name: string\n  /** @writeOnly */\n  password?: string\n}",
    )
    expect(declaration(code, "UserInput")).toBe(
      "{\n  /** @readOnly */\n  id?: string\n  name: string\n  /** @writeOnly */\n  password: string\n}",
    )
    expect(declaration(code, "TeamInput")).toBe("{\n  lead?: UserInput\n}")
    expect(entry(code, "POST /users")).toContain('body: { "application/json": Schemas.TeamInput }')
    expect(entry(code, "POST /users")).toContain(
      '"201": { content: { "application/json": Schemas.Team } }',
    )
    // Variants exist only for schemas a request uses.
    expect(code).not.toContain("UnusedInput")
    await expectPassesTsc(code)
  })

  it("applies them in 3.1+ too, where they are annotations", async () => {
    const result = await generate(readWriteDoc("3.1"))
    expect(declaration(result.code, "UserInput")).toContain("  id?: string")
    expect(entry(result.code, "POST /users")).toContain(
      'body: { "application/json": Schemas.TeamInput }',
    )
    expect(result.diagnostics).toStrictEqual([])
  })
})

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

/** A `POST /pets` that sends and returns `schema`. */
const post = (schema: unknown) => ({
  "/pets": {
    post: {
      requestBody: { content: { "application/json": { schema } } },
      responses: { "200": { description: "OK", content: { "application/json": { schema } } } },
    },
  },
})

describe("readOnly and writeOnly across schemas", () => {
  it.each(["readOnly", "writeOnly"] as const)(
    "handles deeply shared references with %s without expanding every path",
    async (flag) => {
      const schemas: Record<string, unknown> = {
        Level0: { type: "object", properties: { id: { type: "string", [flag]: true } } },
      }
      for (let level = 1; level <= 24; level++) {
        const keyword = ["allOf", "anyOf", "oneOf"][level % 3]
        schemas[`Level${level}`] = {
          [keyword]: [ref(`Level${level - 1}`), ref(`Level${level - 1}`)],
        }
      }
      schemas.Pet = { type: "object", required: ["id"], allOf: [ref("Level24")] }
      const code = await gen(oas("3.0", { paths: post(ref("Pet")), components: { schemas } }))
      const optional = flag === "readOnly" ? "Input" : ""
      const required = flag === "readOnly" ? "" : "Input"
      await expectPassesTsc(
        code,
        [
          'import type { Schemas } from "./file0"',
          `const omitted: Schemas.Pet${optional} = {}`,
          `const present: Schemas.Pet${required} = { id: "x" }`,
          "// @ts-expect-error Shared references preserve the opposite side requirement.",
          `const missing: Schemas.Pet${required} = {}`,
        ].join("\n"),
      )
    },
  )

  it.each([
    ["anyOf", "readOnly"],
    ["anyOf", "writeOnly"],
    ["oneOf", "readOnly"],
    ["oneOf", "writeOnly"],
  ] as const)("applies %s branch %s annotations to outer requirements", async (keyword, flag) => {
    const branch = (type: string, annotation = flag) => ({
      properties: { id: { type, [annotation]: true } },
    })
    const alternatives = [branch("string"), branch("number")]
    const base = {
      type: "object",
      required: ["id"],
      properties: {
        nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    }
    const cases = {
      Inline: { ...base, [keyword]: alternatives },
      Wrapped: { ...base, allOf: [{ [keyword]: alternatives.map((b) => ({ allOf: [b] })) }] },
      Other: { ...base, required: ["id", "other"], [keyword]: alternatives },
      Mixed: { ...base, [keyword]: [alternatives[0], { properties: { id: { type: "number" } } }] },
      Missing: { ...base, [keyword]: [alternatives[0], {}] },
      Conflicting: {
        ...base,
        [keyword]: [
          alternatives[0],
          branch("number", flag === "readOnly" ? "writeOnly" : "readOnly"),
        ],
      },
    }
    const code = await gen(
      oas("3.0", {
        paths: Object.fromEntries(
          Object.entries(cases).map(([name, schema]) => [`/${name}`, post(schema)["/pets"]]),
        ),
      }),
    )
    const optional = flag === "readOnly" ? "Request" : "Response"
    const required = flag === "readOnly" ? "Response" : "Request"
    await expectPassesTsc(
      code,
      [
        'import type { Endpoints } from "./file0"',
        ...Object.keys(cases).flatMap((name) => [
          `type ${name}Request = NonNullable<Endpoints["POST /${name}"]["body"]>["application/json"]`,
          `type ${name}Response = Endpoints["POST /${name}"]["responses"]["200"]["content"]["application/json"]`,
        ]),
        ...["Inline", "Wrapped"].flatMap((name) => [
          `const omitted${name}: ${name}${optional} = {}`,
          `const string${name}: ${name}${required} = { id: "x" }`,
          `const number${name}: ${name}${required} = { id: 1 }`,
          "// @ts-expect-error The opposite side still requires id.",
          `const missing${name}: ${name}${required} = {}`,
          "// @ts-expect-error Parent annotations do not change nested requirements.",
          `const nested${name}: ${name}${optional} = { nested: {} }`,
        ]),
        `const other: Other${optional} = { other: true }`,
        ...["Request", "Response"].flatMap((side) => [
          "// @ts-expect-error Unrelated outer requirements remain required.",
          `const missingOther${side}: Other${side} = { id: "x" }`,
        ]),
        ...["Request", "Response"].flatMap((side) =>
          ["Mixed", "Missing", "Conflicting"].flatMap((name) => {
            const checks = [`const present${name}${side}: ${name}${side} = { id: "x" }`]
            if (side === required && name !== "Conflicting") {
              checks.push(
                "// @ts-expect-error Unannotated and same-direction branches still require id here.",
              )
            }
            checks.push(`const missing${name}${side}: ${name}${side} = {}`)
            return checks
          }),
        ),
      ].join("\n"),
    )
  })

  it.each(["readOnly", "writeOnly"] as const)(
    "propagates %s requiredness through inline unions on both sides",
    async (flag) => {
      const shapes = {
        type: "object",
        properties: {
          id: { type: "string", [flag]: true },
          nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      }
      const alternatives = { anyOf: [{ required: ["id"] }, { required: ["other"] }] }
      const code = await gen(
        oas("3.0", {
          paths: post({ anyOf: [ref("Nested"), ref("Sibling"), ref("Intersection")] }),
          components: {
            schemas: {
              Nested: { ...shapes, allOf: [alternatives] },
              Sibling: { ...shapes, ...alternatives },
              Intersection: {
                ...shapes,
                allOf: [
                  {
                    allOf: [
                      {
                        anyOf: Array.from({ length: 17 }, (_, i) => ({
                          required: ["id", `p${i}`],
                        })),
                      },
                      { anyOf: [{ required: ["a"] }, { required: ["b"] }] },
                    ],
                  },
                ],
              },
            },
          },
        }),
      )
      const optional = flag === "readOnly" ? "Input" : ""
      const required = flag === "readOnly" ? "" : "Input"
      await expectPassesTsc(
        code,
        [
          'import type { Schemas } from "./file0"',
          ...["Nested", "Sibling"].flatMap((name) => [
            `const omitted${name}: Schemas.${name}${optional} = {}`,
            `const present${name}: Schemas.${name}${required} = { id: "x" }`,
            `const alternate${name}: Schemas.${name}${required} = { other: true }`,
            "// @ts-expect-error The property remains required on its applicable side.",
            `const missing${name}: Schemas.${name}${required} = {}`,
            "// @ts-expect-error A parent annotation does not affect nested property names.",
            `const nested${name}: Schemas.${name}${optional} = { nested: {} }`,
          ]),
          `const intersection: Schemas.Intersection${optional} = { p0: true, a: true }`,
          `const presentIntersection: Schemas.Intersection${required} = { id: "x", p0: true, a: true }`,
          "// @ts-expect-error The intersection keeps its requirement on the applicable side.",
          `const missingIntersection: Schemas.Intersection${required} = { p0: true, a: true }`,
        ].join("\n"),
      )
    },
  )

  it("applies a readOnly from one allOf member to a property another requires", async () => {
    const code = await gen(
      oas("3.0", {
        paths: post(ref("Pet")),
        components: {
          schemas: {
            Base: { type: "object", properties: { id: { type: "integer", readOnly: true } } },
            Pet: { allOf: [ref("Base"), { required: ["id", "name"] }] },
            Tag: {
              type: "object",
              required: ["id"],
              properties: { id: { allOf: [{ type: "integer", readOnly: true }] } },
            },
          },
        },
      }),
    )
    expect(declaration(code, "PetInput")).toContain("id?: unknown")
    expect(entry(code, "POST /pets")).toContain('body?: { "application/json": Schemas.PetInput }')
    expect(declaration(code, "Tag")).toContain("id: number")
  })

  it("reads webhook requests as the API sends them, and their responses as you send them", async () => {
    const code = await gen(
      oas("3.1", {
        webhooks: {
          "pet.created": {
            post: {
              requestBody: { content: { "application/json": { schema: ref("Pet") } } },
              responses: {
                "200": {
                  description: "OK",
                  content: { "application/json": { schema: ref("Ack") } },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "integer", readOnly: true } },
            },
            Ack: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "integer", readOnly: true } },
            },
          },
        },
      }),
    )
    const webhook = code.slice(code.indexOf("export interface Webhooks"))
    expect(webhook).toContain('body?: { "application/json": Schemas.Pet }')
    expect(webhook).toContain('"200": { content: { "application/json": Schemas.AckInput } }')
    expect(code).not.toContain("PetInput")
  })

  it("reports a request-side name it had to change", async () => {
    const result = await generate(
      oas("3.0", {
        paths: post(ref("User")),
        components: {
          schemas: {
            User: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "integer", readOnly: true } },
            },
            UserInput: { type: "string" },
          },
        },
      }),
    )
    expect(declaration(result.code, "UserInput2")).toContain("id?: number")
    expect(codes(result.diagnostics)).toStrictEqual(["renamed-schema #/components/schemas/User"])
  })

  it("follows $dynamicRef to readOnly properties as it follows $ref", async () => {
    const [dynamic, plain] = await Promise.all(
      ["$dynamicRef", "$ref"].map((keyword) =>
        gen(
          oas("3.1", {
            paths: post(ref("Pet")),
            components: {
              schemas: {
                Id: { type: "integer", readOnly: true },
                Base: { type: "object", properties: { tag: { type: "string", readOnly: true } } },
                Pet: {
                  type: "object",
                  required: ["id", "tag"],
                  properties: { id: { [keyword]: "#/components/schemas/Id" } },
                  allOf: [{ [keyword]: "#/components/schemas/Base" }],
                },
              },
            },
          }),
        ),
      ),
    )
    expect(declaration(dynamic, "PetInput")).toBe("{ id?: Id; tag?: unknown } & Base")
    expect(dynamic).toBe(plain)
  })
})
