import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { LoadError } from "../src/core/openapi/errors"
import { generate } from "../src/index"
import { expectPassesTsc } from "./_helpers/tsc"

describe("generate (integration)", () => {
  it("generates correct output for petstore fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/petstore.json"))
    expect(code).toMatchSnapshot()
  })

  it("generates correct output for edge-cases fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/edge-cases.json"))
    expect(code).toMatchSnapshot()
  })

  it("generated code is valid as .d.ts and passes tsc --noEmit", async () => {
    const [petstoreCode, edgeCasesCode] = await Promise.all([
      generate(join(import.meta.dirname, "fixtures/petstore.json")),
      generate(join(import.meta.dirname, "fixtures/edge-cases.json")),
    ])
    await expectPassesTsc([petstoreCode, edgeCasesCode])
  })

  it("generates correct output for refs-and-edges fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/refs-and-edges.json"))
    expect(code).toMatchSnapshot()
  })

  it("refs-and-edges fixture is valid as .d.ts and passes tsc --noEmit", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/refs-and-edges.json"))
    await expectPassesTsc([code])
  })

  it("YAML source generates identical output to the JSON source", async () => {
    const [fromYaml, fromJson] = await Promise.all([
      generate(join(import.meta.dirname, "fixtures/petstore.yaml")),
      generate(join(import.meta.dirname, "fixtures/petstore.json")),
    ])
    expect(fromYaml).toBe(fromJson)
  })

  it("generate(doc) accepts unresolved refs and resolves them", () => {
    const doc = {
      components: {
        parameters: { P: { name: "p", in: "query", schema: { type: "string" } } },
      },
      paths: {
        "/x": {
          get: {
            parameters: [{ $ref: "#/components/parameters/P" }],
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    }
    const code = generate(doc)
    expect(code).toContain("query: { p?: string }")
  })

  it("decodes and validates local schema refs", () => {
    const code = generate({
      components: {
        schemas: {
          "User/Profile": { type: "object", properties: { id: { type: "string" } } },
          "Result": { $ref: "#/components/schemas/User~1Profile" },
        },
      },
    })
    expect(code).toContain("export type Result = User_Profile")
    expect(code).toContain("export interface User_Profile")
  })

  it("rejects missing, non-component, and external schema refs", () => {
    expect(() =>
      generate({ components: { schemas: { Result: { $ref: "#/components/schemas/Missing" } } } }),
    ).toThrow(LoadError)
    expect(() =>
      generate({ components: { schemas: { Result: { $ref: "#/$defs/Result" } } } }),
    ).toThrow(LoadError)
    expect(() =>
      generate({ components: { schemas: { Result: { $ref: "./models.yaml#/Pet" } } } }),
    ).toThrow(LoadError)
  })

  it("maps OpenAPI 3.1 boolean schemas to unknown and never", async () => {
    const code = generate({
      openapi: "3.1.0",
      components: { schemas: { Anything: true, Nothing: false } },
    })
    expect(code).toContain("export type Anything = unknown")
    expect(code).toContain("export type Nothing = never")
    await expectPassesTsc([code])
  })

  it("generate(doc) injects discriminator literals end-to-end", () => {
    const code = generate({
      components: {
        schemas: {
          Cat: { type: "object", properties: { purr: { type: "string" } }, required: ["purr"] },
          Dog: { type: "object", properties: { bark: { type: "string" } }, required: ["bark"] },
          Animal: {
            oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
            discriminator: {
              propertyName: "type",
              mapping: { cat: "Cat", dog: "Dog" },
            },
          },
        },
      },
    })
    expect(code).toContain('type: "cat"')
    expect(code).toContain('type: "dog"')
    expect(code).toContain("export type Animal = Cat | Dog")
  })

  it("generate(doc) injects discriminator literals into allOf branches", () => {
    const code = generate({
      components: {
        schemas: {
          BaseAnimal: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          Cat: {
            allOf: [
              { $ref: "#/components/schemas/BaseAnimal" },
              { type: "object", properties: { purr: { type: "string" } } },
            ],
          },
          Animal: {
            oneOf: [{ $ref: "#/components/schemas/Cat" }],
            discriminator: {
              propertyName: "type",
              mapping: { cat: "Cat" },
            },
          },
        },
      },
    })
    expect(code).toContain(
      'export type Cat = BaseAnimal & {\n    purr?: string\n    type: "cat"\n  }',
    )
    expect(code).toContain("export type Animal = Cat")
  })

  it("generate(doc) supports inline discriminator branches", () => {
    const code = generate({
      components: {
        schemas: {
          Animal: {
            oneOf: [
              {
                type: "object",
                properties: { type: { const: "cat" }, purr: { type: "string" } },
              },
              {
                type: "object",
                properties: { type: { enum: ["dog"] }, bark: { type: "string" } },
              },
            ],
            discriminator: { propertyName: "type" },
          },
        },
      },
    })
    expect(code).toContain('type: "cat"')
    expect(code).toContain('type: "dog"')
  })

  it("generate(doc) emits callback types from a component ref", async () => {
    const code = generate({
      components: {
        callbacks: {
          OnEvent: {
            "{$request.body#/callbackUrl}": {
              post: {
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: { type: "string" } } },
                },
                responses: { "204": { description: "accepted" } },
              },
            },
          },
        },
      },
      paths: {
        "/subscribe": {
          post: {
            callbacks: {
              onEvent: { $ref: "#/components/callbacks/OnEvent" },
            },
            responses: { "202": { description: "subscribed" } },
          },
        },
      },
    })
    expect(code).toContain("export interface Callbacks")
    expect(code).toContain('"POST /subscribe > onEvent > POST {$request.body#/callbackUrl}"')
    expect(code).toContain("payload: string")
    expect(code).toContain('reply: { "204": void }')
    await expectPassesTsc([code])
  })

  it("generates correct output for discriminator fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/discriminator.json"))
    expect(code).toMatchSnapshot()
  })

  it("discriminator fixture is valid as .d.ts and passes tsc --noEmit", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/discriminator.json"))
    await expectPassesTsc([code])
  })

  it("generates correct output for 3.0.x fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/3.0.x.json"))
    expect(code).toMatchSnapshot()
  })

  it("generates correct output for 3.1.x fixture", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/3.1.x.json"))
    expect(code).toMatchSnapshot()
  })

  it("3.0.x and 3.1.x fixtures are valid as .d.ts and pass tsc --noEmit", async () => {
    const [v30, v31] = await Promise.all([
      generate(join(import.meta.dirname, "fixtures/3.0.x.json")),
      generate(join(import.meta.dirname, "fixtures/3.1.x.json")),
    ])
    await expectPassesTsc([v30, v31])
  })

  it("formats maps date-time to Date in petstore", async () => {
    const code = await generate(join(import.meta.dirname, "fixtures/petstore.json"), {
      formats: { "date-time": "Date" },
    })
    expect(code).toMatchSnapshot()
  })

  it("headers: false (default) omits header parameters from endpoint type", () => {
    const code = generate({
      paths: {
        "/x": {
          get: {
            parameters: [
              { name: "X-API-Key", in: "header", required: true, schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    })
    expect(code).not.toContain("headers:")
    expect(code).not.toContain("X-API-Key")
  })

  it("headers: true emits typed headers field per endpoint", () => {
    const code = generate(
      {
        paths: {
          "/secure": {
            get: {
              parameters: [
                { name: "X-API-Key", in: "header", required: true, schema: { type: "string" } },
                { name: "X-Trace-Id", in: "header", schema: { type: "string" } },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
          "/public": {
            get: { responses: { "200": { description: "ok" } } },
          },
        },
      },
      { headers: true },
    )
    expect(code).toContain('headers: { "X-API-Key": string; "X-Trace-Id"?: string }')
    expect(code).toContain("headers: void")
  })

  it("3.0 nullable enum keeps literal types", () => {
    const code = generate({
      openapi: "3.0.3",
      components: {
        schemas: { Color: { type: "string", enum: ["red", "blue"], nullable: true } },
      },
    })
    expect(code).toContain('export type Color = "red" | "blue" | null')
  })

  it("3.0 nullable object keeps null in the alias", () => {
    const code = generate({
      openapi: "3.0.3",
      components: {
        schemas: {
          Box: { type: "object", nullable: true, properties: { a: { type: "string" } } },
        },
      },
    })
    expect(code).toContain("export type Box = {\n    a?: string\n  } | null")
  })

  it("3.0 nullable composition keeps the composition and null branches", () => {
    const code = generate({
      openapi: "3.0.3",
      components: {
        schemas: {
          Base: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
          Ext: {
            type: "object",
            nullable: true,
            allOf: [{ $ref: "#/components/schemas/Base" }],
            properties: { extra: { type: "string" } },
            required: ["extra"],
          },
        },
      },
    })
    expect(code).toContain("export type Ext = (Base & {\n    extra: string\n  }) | null")
  })

  it("3.1 nullable type does not add null to an enum that excludes it", () => {
    const code = generate({
      openapi: "3.1.0",
      components: {
        schemas: { Color: { type: ["string", "null"], enum: ["red"] } },
      },
    })
    expect(code).toContain('export type Color = "red"')
    expect(code).not.toContain('export type Color = "red" | null')
  })

  it("allOf with sibling properties keeps both", () => {
    const code = generate({
      components: {
        schemas: {
          Base: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
          Ext: {
            allOf: [{ $ref: "#/components/schemas/Base" }],
            properties: { extra: { type: "string" } },
            required: ["extra"],
          },
        },
      },
    })
    expect(code).toContain("export type Ext = Base & {\n    extra: string\n  }")
  })

  it("object schema with explicit type and allOf keeps both as an alias", () => {
    const code = generate({
      components: {
        schemas: {
          Base: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
          Ext: {
            type: "object",
            allOf: [{ $ref: "#/components/schemas/Base" }],
            properties: { extra: { type: "string" } },
            required: ["extra"],
          },
        },
      },
    })
    expect(code).toContain("export type Ext = Base & {\n    extra: string\n  }")
  })

  it("conflicting index signature is widened and passes tsc", async () => {
    const code = generate({
      components: {
        schemas: {
          Mixed: {
            type: "object",
            properties: { id: { type: "number" } },
            additionalProperties: { type: "string" },
          },
        },
      },
    })
    expect(code).toContain("[key: string]: string | number | undefined")
    await expectPassesTsc([code])
  })

  it("3.1 operation without responses is allowed", () => {
    const code = generate({
      openapi: "3.1.0",
      paths: { "/ping": { get: { summary: "no responses" } } },
    })
    expect(code).toContain('"GET /ping"')
    expect(code).toContain("response: unknown")
  })

  it("response field is a status-keyed map of every declared response", () => {
    const code = generate({
      paths: {
        "/x": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
              "400": { content: { "application/json": { schema: { type: "string" } } } },
              "default": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    })
    expect(code).toContain('response: { "200": string; "400": string; "default": string }')
  })
})
