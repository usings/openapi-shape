import { describe, expect, it } from "vitest"
import { buildContractType } from "../../../src/core/contract/schema-type"
import { renderContractType } from "../../../src/core/declarations/render-type"
import type { OpenAPISchema } from "../../../src/core/openapi/types"

function render(schema: OpenAPISchema): string {
  return renderContractType(buildContractType(schema))
}

describe("OpenAPI schema to TypeScript rendering", () => {
  it("parenthesizes oneOf before intersecting sibling properties", () => {
    expect(
      render({
        oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
        properties: { common: { type: "string" } },
        required: ["common"],
      }),
    ).toBe("(A | B) & {\n  common: string\n}")
  })

  it("keeps composition constraints beside a nullable type array", () => {
    expect(
      render({
        type: ["object", "null"],
        allOf: [{ $ref: "#/components/schemas/Base" }],
        properties: { extra: { type: "string" } },
        required: ["extra"],
      }),
    ).toBe("Base & ({\n  extra: string\n} | null)")
  })

  it("widens an index type with optional property types", () => {
    expect(
      render({
        type: "object",
        properties: { id: { type: "number" } },
        additionalProperties: { type: "string" },
      }),
    ).toBe("{\n  id?: number\n  [key: string]: string | number | undefined\n}")
  })
})
