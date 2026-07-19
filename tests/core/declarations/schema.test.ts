import { describe, expect, it } from "vitest"
import type { ContractSchema } from "../../../src/core/contract/contract"
import { renderContractType } from "../../../src/core/declarations/render-type"
import { renderSchemas } from "../../../src/core/declarations/schema"

describe("renderContractType: primitives/literals/references", () => {
  it("scalar name", () => {
    expect(renderContractType({ kind: "scalar", name: "string" })).toBe("string")
  })
  it("binary renders Blob by default", () => {
    expect(renderContractType({ kind: "binary" })).toBe("Blob")
  })
  it("string literal quoted", () => {
    expect(renderContractType({ kind: "literal", value: "x" })).toBe('"x"')
  })
  it("number literal", () => {
    expect(renderContractType({ kind: "literal", value: 42 })).toBe("42")
  })
  it("null literal", () => {
    expect(renderContractType({ kind: "literal", value: null })).toBe("null")
  })
  it("reference emits identifier", () => {
    expect(renderContractType({ kind: "reference", name: "User" })).toBe("User")
  })
  it("reference honors the refPrefix option", () => {
    expect(renderContractType({ kind: "reference", name: "User" }, { refPrefix: "Schemas." })).toBe(
      "Schemas.User",
    )
  })
})

describe("renderContractType: array/tuple/record", () => {
  it("array of strings", () => {
    expect(renderContractType({ kind: "array", items: { kind: "scalar", name: "string" } })).toBe(
      "string[]",
    )
  })
  it("array of union → parenthesized", () => {
    expect(
      renderContractType({
        kind: "array",
        items: {
          kind: "union",
          members: [
            { kind: "scalar", name: "string" },
            { kind: "scalar", name: "number" },
          ],
        },
      }),
    ).toBe("(string | number)[]")
  })
  it("tuple no rest", () => {
    expect(
      renderContractType({
        kind: "tuple",
        items: [
          { kind: "scalar", name: "string" },
          { kind: "scalar", name: "number" },
        ],
      }),
    ).toBe("[string, number]")
  })
  it("tuple with rest", () => {
    expect(
      renderContractType({
        kind: "tuple",
        items: [{ kind: "scalar", name: "string" }],
        rest: { kind: "unknown" },
      }),
    ).toBe("[string, ...unknown[]]")
  })
  it("record", () => {
    expect(renderContractType({ kind: "record", values: { kind: "scalar", name: "number" } })).toBe(
      "Record<string, number>",
    )
  })
})

describe("renderContractType: union/intersection", () => {
  it("union", () => {
    expect(
      renderContractType({
        kind: "union",
        members: [
          { kind: "scalar", name: "string" },
          { kind: "scalar", name: "null" },
        ],
      }),
    ).toBe("string | null")
  })
  it("intersection", () => {
    expect(
      renderContractType({
        kind: "intersection",
        members: [
          { kind: "reference", name: "A" },
          { kind: "reference", name: "B" },
        ],
      }),
    ).toBe("A & B")
  })
  it("deduplicates union members and collapses to one", () => {
    expect(
      renderContractType({
        kind: "union",
        members: [
          { kind: "reference", name: "A" },
          { kind: "reference", name: "A" },
        ],
      }),
    ).toBe("A")
  })
  it("wraps intersection members inside unions", () => {
    expect(
      renderContractType({
        kind: "union",
        members: [
          {
            kind: "intersection",
            members: [
              { kind: "reference", name: "A" },
              { kind: "reference", name: "B" },
            ],
          },
          { kind: "scalar", name: "null" },
        ],
      }),
    ).toBe("(A & B) | null")
  })
})

describe("renderContractType: object", () => {
  it("inline object required field", () => {
    expect(
      renderContractType({
        kind: "object",
        fields: [{ name: "a", required: true, type: { kind: "scalar", name: "number" } }],
      }),
    ).toBe("{\n  a: number\n}")
  })
  it("optional field", () => {
    expect(
      renderContractType({
        kind: "object",
        fields: [{ name: "a", required: false, type: { kind: "scalar", name: "number" } }],
      }),
    ).toBe("{\n  a?: number\n}")
  })
  it("widens the index signature with declared field types", () => {
    expect(
      renderContractType({
        kind: "object",
        fields: [{ name: "a", required: true, type: { kind: "scalar", name: "string" } }],
        index: { kind: "scalar", name: "string" },
      }),
    ).toBe("{\n  a: string\n  [key: string]: string\n}")
  })
})

describe("renderContractType: format mappings", () => {
  it("maps scalar formats through the formats option", () => {
    expect(
      renderContractType(
        { kind: "scalar", name: "string", format: "date-time" },
        { formats: { "date-time": "Date" } },
      ),
    ).toBe("Date")
  })
  it("ignores formats on non-mappable scalars", () => {
    expect(
      renderContractType(
        { kind: "scalar", name: "boolean", format: "int64" },
        { formats: { int64: "bigint" } },
      ),
    ).toBe("boolean")
  })
  it("lets a binary format mapping override Blob", () => {
    expect(
      renderContractType(
        { kind: "binary", format: "binary" },
        { formats: { binary: "Uint8Array" } },
      ),
    ).toBe("Uint8Array")
  })
})

describe("renderSchemas: ordering (aliases first, interfaces second)", () => {
  it("emits aliases before interfaces, matching current behavior", () => {
    const schemas: ContractSchema[] = [
      {
        name: "User",
        originalName: "User",
        kind: "interface",
        fields: [{ name: "id", required: true, type: { kind: "scalar", name: "number" } }],
      },
      {
        name: "Status",
        originalName: "Status",
        kind: "alias",
        type: {
          kind: "union",
          members: [
            { kind: "literal", value: "a" },
            { kind: "literal", value: "b" },
          ],
        },
      },
    ]
    const out = renderSchemas(schemas)
    expect(out.indexOf("export type Status")).toBeLessThan(out.indexOf("export interface User"))
    expect(out).toBe(
      `export namespace Schemas {\n  export type Status = "a" | "b"\n\n  export interface User {\n    id: number\n  }\n}`,
    )
  })
})

describe("renderSchemas: contract type rendering", () => {
  it("renders references, format mappings, and index types from contract schemas", () => {
    const schemas: ContractSchema[] = [
      {
        name: "User",
        originalName: "User",
        kind: "interface",
        fields: [
          { name: "id", required: true, type: { kind: "scalar", name: "number" } },
          {
            name: "createdAt",
            required: false,
            type: { kind: "scalar", name: "string", format: "date-time" },
          },
        ],
        index: {
          kind: "union",
          members: [
            { kind: "scalar", name: "string" },
            { kind: "scalar", name: "number" },
          ],
        },
      },
      {
        name: "UserList",
        originalName: "UserList",
        kind: "alias",
        type: { kind: "array", items: { kind: "reference", name: "User" } },
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
