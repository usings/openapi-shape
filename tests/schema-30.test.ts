import { describe, expect, it } from "vitest"
import { generate } from "../src/index"
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
