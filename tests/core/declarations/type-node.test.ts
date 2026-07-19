import { describe, expect, it } from "vitest"
import type { OpenAPISchema } from "../../../src/core/contract/openapi"
import { renderTypeNode } from "../../../src/core/declarations/schema"
import { schemaToTypeNode } from "../../../src/core/declarations/type-node"

function render(schema: OpenAPISchema): string {
  return renderTypeNode(schemaToTypeNode(schema, {}))
}

describe("schemaToTypeNode: enum with nullable type array", () => {
  it("does not add null when the enum excludes it", () => {
    expect(render({ type: ["string", "null"], enum: ["red", "blue"] })).toBe('"red" | "blue"')
  })

  it("does not duplicate null when enum already contains it", () => {
    expect(render({ type: ["string", "null"], enum: ["red", null] })).toBe('"red" | null')
  })

  it("plain enum without type array is unchanged", () => {
    expect(render({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"')
  })
})

describe("schemaToTypeNode: composition keywords with siblings", () => {
  it("keeps sibling properties next to allOf as an intersection member", () => {
    expect(
      render({
        allOf: [{ $ref: "#/components/schemas/Base" }],
        properties: { extra: { type: "string" } },
        required: ["extra"],
      }),
    ).toBe("Base & {\n  extra: string\n}")
  })

  it("keeps sibling properties next to oneOf", () => {
    expect(
      render({
        oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
        properties: { common: { type: "string" } },
        required: ["common"],
      }),
    ).toBe("(A | B) & {\n  common: string\n}")
  })

  it("keeps sibling properties next to anyOf", () => {
    expect(
      render({
        anyOf: [{ $ref: "#/components/schemas/A" }],
        properties: { common: { type: "string" } },
        required: ["common"],
      }),
    ).toBe("A & {\n  common: string\n}")
  })

  it("ignores a bare sibling type: object that adds no constraints", () => {
    expect(
      render({
        type: "object",
        oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
      }),
    ).toBe("A | B")
  })

  it("allOf without siblings stays a plain intersection", () => {
    expect(
      render({
        allOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
      }),
    ).toBe("A & B")
  })

  it("empty oneOf still collapses to never", () => {
    expect(render({ oneOf: [] })).toBe("never")
  })

  it("keeps composition constraints beside a type array", () => {
    expect(
      render({
        type: ["object", "null"],
        allOf: [{ $ref: "#/components/schemas/Base" }],
        properties: { extra: { type: "string" } },
        required: ["extra"],
      }),
    ).toBe("Base & ({\n  extra: string\n} | null)")
  })
})

describe("schemaToTypeNode: index signature widening", () => {
  it("emits an unknown index signature for additionalProperties: true", () => {
    expect(
      render({
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: true,
      }),
    ).toBe("{\n  id: number\n  [key: string]: unknown\n}")
  })

  it("lets additionalProperties: true subsume pattern property value types", () => {
    expect(
      render({
        type: "object",
        properties: { id: { type: "number" } },
        patternProperties: { "^x-": { type: "string" } },
        additionalProperties: true,
      }),
    ).toBe("{\n  id?: number\n  [key: string]: unknown\n}")
  })

  it("widens the index type with declared property types", () => {
    expect(
      render({
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: { type: "string" },
      }),
    ).toBe("{\n  id: number\n  [key: string]: string | number\n}")
  })

  it("adds undefined when a declared property is optional", () => {
    expect(
      render({
        type: "object",
        properties: { id: { type: "number" } },
        additionalProperties: { type: "string" },
      }),
    ).toBe("{\n  id?: number\n  [key: string]: string | number | undefined\n}")
  })

  it("does not duplicate property types already covered by the index type", () => {
    expect(
      render({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: { type: "string" },
      }),
    ).toBe("{\n  name: string\n  [key: string]: string\n}")
  })
})
