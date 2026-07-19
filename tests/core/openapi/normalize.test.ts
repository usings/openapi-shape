import { describe, expect, it } from "vitest"
import { LoadError } from "../../../src/core/openapi/errors"
import { normalize } from "../../../src/core/openapi/normalize"
import type { OpenAPISchemaObject } from "../../../src/core/openapi/types"

function schemaObject(schema: unknown): OpenAPISchemaObject {
  return schema as OpenAPISchemaObject
}

describe("normalize: version handling", () => {
  it.each(["3.2.0", "2.0"])("throws LoadError on unsupported version %s", (version) => {
    expect(() => normalize({ openapi: version })).toThrow(LoadError)
  })

  it("throws LoadError when input is not an object", () => {
    expect(() => normalize(null)).toThrow(LoadError)
    expect(() => normalize("hi")).toThrow(LoadError)
    expect(() => normalize(42)).toThrow(LoadError)
  })
})

describe("normalize: 3.0 nullable rewrite", () => {
  it("rewrites nullable: true on string", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: { schemas: { X: { type: "string", nullable: true } } },
    })
    expect(out.components?.schemas?.X).toStrictEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })

  it("rewrites nested nullable inside properties", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: {
          X: {
            type: "object",
            properties: { a: { type: "integer", nullable: true } },
          },
        },
      },
    })
    expect(schemaObject(out.components?.schemas?.X).properties?.a).toStrictEqual({
      anyOf: [{ type: "integer" }, { type: "null" }],
    })
  })

  it("walks into oneOf/anyOf/allOf branches", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: {
          X: {
            oneOf: [{ type: "string", nullable: true }, { type: "integer" }],
          },
        },
      },
    })
    expect(schemaObject(out.components?.schemas?.X).oneOf?.[0]).toStrictEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })

  it("walks into patternProperties values", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: {
          X: {
            type: "object",
            patternProperties: { "^x-": { type: "string", nullable: true } },
          },
        },
      },
    })
    expect(schemaObject(out.components?.schemas?.X).patternProperties?.["^x-"]).toStrictEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })

  it("walks into items and prefixItems", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: {
          X: { type: "array", items: { type: "string", nullable: true } },
          Y: {
            type: "array",
            prefixItems: [{ type: "string", nullable: true }],
          },
        },
      },
    })
    expect(schemaObject(out.components?.schemas?.X).items).toStrictEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
    expect(schemaObject(out.components?.schemas?.Y).prefixItems?.[0]).toStrictEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })

  it("rewrites nullable: true on object, keeping object keywords", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: { X: { type: "object", nullable: true, properties: { a: { type: "string" } } } },
      },
    })
    expect(out.components?.schemas?.X).toStrictEqual({
      anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "null" }],
    })
  })

  it("rewrites nullable: true on array, keeping items", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: { X: { type: "array", nullable: true, items: { type: "string" } } },
      },
    })
    expect(out.components?.schemas?.X).toStrictEqual({
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    })
  })

  it("keeps enum alongside the rewritten nullable type", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: { X: { type: "string", enum: ["red", "blue"], nullable: true } },
      },
    })
    expect(out.components?.schemas?.X).toStrictEqual({
      anyOf: [{ type: "string", enum: ["red", "blue"] }, { type: "null" }],
    })
  })

  it("structural sharing: untouched subtree preserved by reference", () => {
    const inner = { type: "object", properties: { a: { type: "string" } } }
    const out = normalize({
      openapi: "3.0.3",
      components: { schemas: { X: inner } },
    })
    expect(out.components?.schemas?.X).toBe(inner)
  })

  it("rewrites nullable in parameter schemas (path/query)", () => {
    const out = normalize({
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            parameters: [{ name: "id", in: "query", schema: { type: "string", nullable: true } }],
            responses: {},
          },
        },
      },
    })
    expect(out.paths?.["/x"]?.get?.parameters?.[0]?.schema).toStrictEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })

  it("rewrites nullable in request body schemas", () => {
    const out = normalize({
      openapi: "3.0.3",
      paths: {
        "/x": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "string", nullable: true },
                },
              },
            },
            responses: {},
          },
        },
      },
    })
    expect(
      out.paths?.["/x"]?.post?.requestBody?.content?.["application/json"]?.schema,
    ).toStrictEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })
})
