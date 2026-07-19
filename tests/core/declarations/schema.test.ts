import { describe, expect, it } from "vitest"
import type { ContractSchema } from "../../../src/core/contract/contract"
import { renderTypeNode, renderSchemas } from "../../../src/core/declarations/schema"

describe("renderTypeNode: primitives/literals/refs", () => {
  it("primitive name", () => {
    expect(renderTypeNode({ kind: "primitive", name: "string" })).toBe("string")
    expect(renderTypeNode({ kind: "primitive", name: "Blob" })).toBe("Blob")
  })
  it("string literal quoted", () => {
    expect(renderTypeNode({ kind: "literal", value: "x" })).toBe('"x"')
  })
  it("number literal", () => {
    expect(renderTypeNode({ kind: "literal", value: 42 })).toBe("42")
  })
  it("null literal", () => {
    expect(renderTypeNode({ kind: "literal", value: null })).toBe("null")
  })
  it("ref emits identifier", () => {
    expect(renderTypeNode({ kind: "ref", name: "User" })).toBe("User")
  })
})

describe("renderTypeNode: array/tuple/record", () => {
  it("array of strings", () => {
    expect(renderTypeNode({ kind: "array", items: { kind: "primitive", name: "string" } })).toBe(
      "string[]",
    )
  })
  it("array of union → parenthesized", () => {
    expect(
      renderTypeNode({
        kind: "array",
        items: {
          kind: "union",
          members: [
            { kind: "primitive", name: "string" },
            { kind: "primitive", name: "number" },
          ],
        },
      }),
    ).toBe("(string | number)[]")
  })
  it("tuple no rest", () => {
    expect(
      renderTypeNode({
        kind: "tuple",
        items: [
          { kind: "primitive", name: "string" },
          { kind: "primitive", name: "number" },
        ],
        rest: null,
      }),
    ).toBe("[string, number]")
  })
  it("tuple with rest", () => {
    expect(
      renderTypeNode({
        kind: "tuple",
        items: [{ kind: "primitive", name: "string" }],
        rest: { kind: "primitive", name: "unknown" },
      }),
    ).toBe("[string, ...unknown[]]")
  })
  it("record", () => {
    expect(renderTypeNode({ kind: "record", values: { kind: "primitive", name: "number" } })).toBe(
      "Record<string, number>",
    )
  })
})

describe("renderTypeNode: union/intersection", () => {
  it("union", () => {
    expect(
      renderTypeNode({
        kind: "union",
        members: [
          { kind: "primitive", name: "string" },
          { kind: "primitive", name: "null" },
        ],
      }),
    ).toBe("string | null")
  })
  it("intersection", () => {
    expect(
      renderTypeNode({
        kind: "intersection",
        members: [
          { kind: "ref", name: "A" },
          { kind: "ref", name: "B" },
        ],
      }),
    ).toBe("A & B")
  })
})

describe("renderTypeNode: object", () => {
  it("inline object required field", () => {
    expect(
      renderTypeNode({
        kind: "object",
        fields: [{ name: "a", required: true, type: { kind: "primitive", name: "number" } }],
        index: null,
      }),
    ).toBe("{\n  a: number\n}")
  })
  it("optional field", () => {
    expect(
      renderTypeNode({
        kind: "object",
        fields: [{ name: "a", required: false, type: { kind: "primitive", name: "number" } }],
        index: null,
      }),
    ).toBe("{\n  a?: number\n}")
  })
  it("with index signature", () => {
    expect(
      renderTypeNode({
        kind: "object",
        fields: [{ name: "a", required: true, type: { kind: "primitive", name: "string" } }],
        index: { kind: "primitive", name: "string" },
      }),
    ).toBe("{\n  a: string\n  [key: string]: string\n}")
  })
})

describe("renderTypeNode: raw", () => {
  it("emits text verbatim", () => {
    expect(renderTypeNode({ kind: "raw", text: "Date" })).toBe("Date")
  })
})

describe("renderSchemas: ordering (aliases first, interfaces second)", () => {
  it("emits aliases before interfaces, matching current behavior", () => {
    const schemas: ContractSchema[] = [
      {
        name: "User",
        originalName: "User",
        kind: "interface",
        fields: [
          { name: "id", required: true, shape: { kind: "schema", schema: { type: "number" } } },
        ],
      },
      {
        name: "Status",
        originalName: "Status",
        kind: "alias",
        shape: { kind: "schema", schema: { enum: ["a", "b"] } },
      },
    ]
    const out = renderSchemas(schemas)
    expect(out.indexOf("export type Status")).toBeLessThan(out.indexOf("export interface User"))
    expect(out).toBe(
      `export namespace Schemas {\n  export type Status = "a" | "b"\n\n  export interface User {\n    id: number\n  }\n}`,
    )
  })
})

describe("renderSchemas: schema shape conversion", () => {
  it("renders refs, format mappings, and index shapes from contract schema shapes", () => {
    const schemas: ContractSchema[] = [
      {
        name: "User",
        originalName: "User",
        kind: "interface",
        fields: [
          {
            name: "id",
            required: true,
            shape: { kind: "schema", schema: { type: "integer" } },
          },
          {
            name: "createdAt",
            required: false,
            shape: { kind: "schema", schema: { type: "string", format: "date-time" } },
          },
        ],
        index: { kind: "schema", schema: { anyOf: [{ type: "string" }, { type: "number" }] } },
      },
      {
        name: "UserList",
        originalName: "UserList",
        kind: "alias",
        shape: {
          kind: "schema",
          schema: { type: "array", items: { $ref: "#/components/schemas/User" } },
        },
      },
    ]

    expect(renderSchemas(schemas, { formats: { "date-time": "Date" } })).toContain(
      "export type UserList = User[]",
    )
    expect(renderSchemas(schemas, { formats: { "date-time": "Date" } })).toContain(
      "createdAt?: Date",
    )
    expect(renderSchemas(schemas)).toContain("[key: string]: string | number")
  })
})
