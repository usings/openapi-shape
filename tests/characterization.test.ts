import { describe, expect, it } from "vitest"
import { generate } from "../src/index"

/**
 * Characterization tests written before decoupling the contract IR from
 * OpenAPI schema types. They freeze observable `generate()` behavior,
 * including deliberate quirks, so the refactor can be verified as a pure
 * restructuring. Behavior changes must update these tests explicitly.
 */
describe("record-style objects", () => {
  it("renders an object without properties as Record<string, unknown>", () => {
    const code = generate({
      components: { schemas: { Bag: { type: "object" } } },
    })
    expect(code).toContain("export type Bag = Record<string, unknown>")
  })

  it("renders schema-valued additionalProperties as the record value type", () => {
    const code = generate({
      components: {
        schemas: { Bag: { type: "object", additionalProperties: { type: "string" } } },
      },
    })
    expect(code).toContain("export type Bag = Record<string, string>")
  })

  it("unions patternProperties values into the record value type", () => {
    const code = generate({
      components: {
        schemas: {
          Bag: {
            type: "object",
            patternProperties: { "^s_": { type: "string" }, "^n_": { type: "number" } },
          },
        },
      },
    })
    expect(code).toContain("export type Bag = Record<string, string | number>")
  })
})

describe("format mappings and binary payloads", () => {
  it("lets a custom binary format mapping override the built-in Blob", () => {
    const code = generate(
      {
        components: {
          schemas: { Upload: { type: "string", format: "binary" } },
        },
      },
      { formats: { binary: "Uint8Array" } },
    )
    expect(code).toContain("export type Upload = Uint8Array")
  })

  it("renders binary and byte string schemas as Blob by default", () => {
    const code = generate({
      components: {
        schemas: {
          Bin: { type: "string", format: "binary" },
          B64: { type: "string", format: "byte" },
        },
      },
    })
    expect(code).toContain("export type Bin = Blob")
    expect(code).toContain("export type B64 = Blob")
  })

  it("applies format mappings to integer schemas", () => {
    const code = generate(
      { components: { schemas: { Big: { type: "integer", format: "int64" } } } },
      { formats: { int64: "bigint" } },
    )
    expect(code).toContain("export type Big = bigint")
  })

  it("keeps null alongside a mapped format in a nullable type array", () => {
    const code = generate(
      {
        openapi: "3.1.0",
        components: { schemas: { When: { type: ["string", "null"], format: "date-time" } } },
      },
      { formats: { "date-time": "Date" } },
    )
    expect(code).toContain("export type When = Date | null")
  })

  it("ignores format mappings on non-mappable types", () => {
    const code = generate(
      { components: { schemas: { Flag: { type: "boolean", format: "int64" } } } },
      { formats: { int64: "bigint" } },
    )
    expect(code).toContain("export type Flag = boolean")
  })

  it("quirk: a schema with only a format renders unknown even when mapped", () => {
    const code = generate(
      { components: { schemas: { Id: { format: "uuid" } } } },
      { formats: { uuid: "UUID" } },
    )
    expect(code).toContain("export type Id = unknown")
  })
})

describe("schemas without an explicit type", () => {
  it("quirk: top-level properties without type: object render unknown", () => {
    const code = generate({
      components: {
        schemas: { Loose: { properties: { id: { type: "string" } } } },
      },
    })
    expect(code).toContain("export type Loose = unknown")
  })

  it("treats properties without type as an object inside compositions", () => {
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
})

describe("tuples", () => {
  it("renders prefixItems with items: true as a tuple with unknown rest", () => {
    const code = generate({
      openapi: "3.1.0",
      components: {
        schemas: {
          Pair: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
            items: true,
          },
        },
      },
    })
    expect(code).toContain("export type Pair = [string, number, ...unknown[]]")
  })

  it("renders prefixItems with a rest schema", () => {
    const code = generate({
      openapi: "3.1.0",
      components: {
        schemas: {
          Row: {
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "boolean" },
          },
        },
      },
    })
    expect(code).toContain("export type Row = [string, ...boolean[]]")
  })

  it("renders items: true without prefixItems as unknown[]", () => {
    const code = generate({
      openapi: "3.1.0",
      components: { schemas: { List: { type: "array", items: true } } },
    })
    expect(code).toContain("export type List = unknown[]")
  })
})

describe("nested property documentation", () => {
  it("renders JSDoc for properties of nested inline objects", () => {
    const code = generate({
      components: {
        schemas: {
          Outer: {
            type: "object",
            properties: {
              inner: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Inner identifier." },
                },
              },
            },
          },
        },
      },
    })
    expect(code).toContain("/** @description Inner identifier. */")
  })
})

describe("response media-type selection", () => {
  it("maps binary content types without a schema to Blob", () => {
    const code = generate({
      paths: {
        "/f": {
          get: {
            responses: {
              "200": { content: { "application/octet-stream": {} } },
            },
          },
        },
      },
    })
    expect(code).toContain('response: { "200": Blob }')
  })

  it("maps text content types to string", () => {
    const code = generate({
      paths: {
        "/t": {
          get: {
            responses: { "200": { content: { "text/plain": {} } } },
          },
        },
      },
    })
    expect(code).toContain('response: { "200": string }')
  })

  it("falls back to the declared schema for unknown content types", () => {
    const code = generate({
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                content: { "application/x-custom": { schema: { type: "number" } } },
              },
            },
          },
        },
      },
    })
    expect(code).toContain('response: { "200": number }')
  })

  it("falls back to Blob for unknown content types without a schema", () => {
    const code = generate({
      paths: {
        "/x": {
          get: {
            responses: { "200": { content: { "application/x-custom": {} } } },
          },
        },
      },
    })
    expect(code).toContain('response: { "200": Blob }')
  })
})

describe("union and literal edge cases", () => {
  it("deduplicates identical oneOf branches", () => {
    const code = generate({
      components: {
        schemas: {
          A: { type: "object", properties: { x: { type: "string" } } },
          Either: {
            oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/A" }],
          },
        },
      },
    })
    expect(code).toContain("export type Either = A\n")
  })

  it("renders unsupported const values as unknown", () => {
    const code = generate({
      components: { schemas: { Fixed: { const: { nested: true } } } },
    })
    expect(code).toContain("export type Fixed = unknown")
  })

  it("renders an empty enum as never", () => {
    const code = generate({
      components: { schemas: { None: { type: "string", enum: [] } } },
    })
    expect(code).toContain("export type None = never")
  })

  it("deduplicates repeated enum values", () => {
    const code = generate({
      components: { schemas: { Dup: { type: "string", enum: ["a", "a", "b"] } } },
    })
    expect(code).toContain('export type Dup = "a" | "b"')
  })
})

describe("request body selection", () => {
  it("keeps non-JSON request bodies as their schema type", () => {
    const code = generate({
      paths: {
        "/upload": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            responses: { "204": { description: "ok" } },
          },
        },
      },
    })
    expect(code).toContain("body: Blob")
  })
})
