import { describe, expect, it } from "vitest"
import type { ContractType } from "../../../src/core/contract/model"
import { buildContractType } from "../../../src/core/contract/schema-type"
import { LoadError } from "../../../src/core/openapi/errors"

const unknown: ContractType = { kind: "unknown" }

describe("buildContractType: degenerate schemas", () => {
  it("maps undefined to unknown", () => {
    expect(buildContractType(undefined)).toStrictEqual(unknown)
  })

  it("maps boolean schemas to unknown and never", () => {
    expect(buildContractType(true)).toStrictEqual(unknown)
    expect(buildContractType(false)).toStrictEqual({ kind: "never" })
  })

  it("maps an empty schema object to unknown", () => {
    expect(buildContractType({})).toStrictEqual(unknown)
  })

  it("quirk: properties without an explicit type stay unknown", () => {
    expect(buildContractType({ properties: { id: { type: "string" } } })).toStrictEqual(unknown)
  })

  it("quirk: a format-only schema stays unknown", () => {
    expect(buildContractType({ format: "uuid" })).toStrictEqual(unknown)
  })
})

describe("buildContractType: scalars", () => {
  it("maps primitive types to scalars", () => {
    expect(buildContractType({ type: "string" })).toStrictEqual({ kind: "scalar", name: "string" })
    expect(buildContractType({ type: "boolean" })).toStrictEqual({
      kind: "scalar",
      name: "boolean",
    })
    expect(buildContractType({ type: "null" })).toStrictEqual({ kind: "scalar", name: "null" })
  })

  it("collapses integer to the number scalar", () => {
    expect(buildContractType({ type: "integer" })).toStrictEqual({ kind: "scalar", name: "number" })
  })

  it("keeps the declared format on scalars for renderer format mappings", () => {
    expect(buildContractType({ type: "string", format: "date-time" })).toStrictEqual({
      kind: "scalar",
      name: "string",
      format: "date-time",
    })
  })

  it("maps unsupported type strings to unknown", () => {
    expect(buildContractType({ type: "file" })).toStrictEqual(unknown)
  })
})

describe("buildContractType: binary payloads", () => {
  it("maps binary and byte string schemas to the binary kind", () => {
    expect(buildContractType({ type: "string", format: "binary" })).toStrictEqual({
      kind: "binary",
      format: "binary",
    })
    expect(buildContractType({ type: "string", format: "byte" })).toStrictEqual({
      kind: "binary",
      format: "byte",
    })
  })

  it("keeps binary formats on non-string types as plain scalars", () => {
    expect(buildContractType({ type: "number", format: "binary" })).toStrictEqual({
      kind: "scalar",
      name: "number",
      format: "binary",
    })
  })
})

describe("buildContractType: literals", () => {
  it("maps supported const values to literals", () => {
    expect(buildContractType({ const: "a" })).toStrictEqual({ kind: "literal", value: "a" })
    expect(buildContractType({ const: 1 })).toStrictEqual({ kind: "literal", value: 1 })
    expect(buildContractType({ const: null })).toStrictEqual({ kind: "literal", value: null })
  })

  it("maps unsupported const values to unknown", () => {
    expect(buildContractType({ const: { nested: true } })).toStrictEqual(unknown)
  })

  it("maps enums to literal unions with deduplication", () => {
    expect(buildContractType({ type: "string", enum: ["a", "a", "b"] })).toStrictEqual({
      kind: "union",
      members: [
        { kind: "literal", value: "a" },
        { kind: "literal", value: "b" },
      ],
    })
  })

  it("collapses a single-value enum and maps an empty enum to never", () => {
    expect(buildContractType({ enum: ["only"] })).toStrictEqual({ kind: "literal", value: "only" })
    expect(buildContractType({ type: "string", enum: [] })).toStrictEqual({ kind: "never" })
  })
})

describe("buildContractType: references", () => {
  it("resolves schema refs to sanitized reference names", () => {
    expect(buildContractType({ $ref: "#/components/schemas/User~1Profile" })).toStrictEqual({
      kind: "reference",
      name: "User_Profile",
    })
  })

  it("rejects refs outside components.schemas", () => {
    expect(() => buildContractType({ $ref: "./models.yaml#/Pet" })).toThrow(LoadError)
  })
})

describe("buildContractType: type arrays", () => {
  it("maps a nullable type array to a union with null", () => {
    expect(buildContractType({ type: ["string", "null"] })).toStrictEqual({
      kind: "union",
      members: [
        { kind: "scalar", name: "string" },
        { kind: "scalar", name: "null" },
      ],
    })
  })

  it("collapses a single-entry type array", () => {
    expect(buildContractType({ type: ["string"] })).toStrictEqual({
      kind: "scalar",
      name: "string",
    })
  })

  it("maps an empty type array to never", () => {
    expect(buildContractType({ type: [] })).toStrictEqual({ kind: "never" })
  })

  it("lets enum override the type array without adding null", () => {
    expect(buildContractType({ type: ["string", "null"], enum: ["red"] })).toStrictEqual({
      kind: "literal",
      value: "red",
    })
  })

  it("keeps formats on non-null scalars expanded from a type array", () => {
    expect(buildContractType({ type: ["string", "null"], format: "date-time" })).toStrictEqual({
      kind: "union",
      members: [
        { kind: "scalar", name: "string", format: "date-time" },
        { kind: "scalar", name: "null" },
      ],
    })
  })
})

describe("buildContractType: compositions", () => {
  const refA: ContractType = { kind: "reference", name: "A" }
  const refB: ContractType = { kind: "reference", name: "B" }

  it("maps allOf to an intersection", () => {
    expect(
      buildContractType({
        allOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
      }),
    ).toStrictEqual({ kind: "intersection", members: [refA, refB] })
  })

  it("maps oneOf and anyOf to unions and collapses single branches", () => {
    expect(
      buildContractType({
        oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
      }),
    ).toStrictEqual({ kind: "union", members: [refA, refB] })
    expect(buildContractType({ anyOf: [{ $ref: "#/components/schemas/A" }] })).toStrictEqual(refA)
  })

  it("maps an empty oneOf to never", () => {
    expect(buildContractType({ oneOf: [] })).toStrictEqual({ kind: "never" })
  })

  it("keeps sibling properties beside allOf as an intersection member", () => {
    expect(
      buildContractType({
        allOf: [{ $ref: "#/components/schemas/A" }],
        properties: { extra: { type: "string" } },
        required: ["extra"],
      }),
    ).toStrictEqual({
      kind: "intersection",
      members: [
        refA,
        {
          kind: "object",
          fields: [{ name: "extra", required: true, type: { kind: "scalar", name: "string" } }],
        },
      ],
    })
  })

  it("ignores a bare sibling type: object that adds no constraints", () => {
    expect(
      buildContractType({
        type: "object",
        oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
      }),
    ).toStrictEqual({ kind: "union", members: [refA, refB] })
  })
})

describe("buildContractType: arrays and tuples", () => {
  it("maps array items", () => {
    expect(buildContractType({ type: "array", items: { type: "number" } })).toStrictEqual({
      kind: "array",
      items: { kind: "scalar", name: "number" },
    })
  })

  it("maps missing or boolean items to unknown[]", () => {
    expect(buildContractType({ type: "array" })).toStrictEqual({ kind: "array", items: unknown })
    expect(buildContractType({ type: "array", items: true })).toStrictEqual({
      kind: "array",
      items: unknown,
    })
  })

  it("maps items: false without prefixItems to an empty tuple", () => {
    expect(buildContractType({ type: "array", items: false })).toStrictEqual({
      kind: "tuple",
      items: [],
    })
  })

  it("maps prefixItems to tuples with optional rest", () => {
    expect(
      buildContractType({
        type: "array",
        prefixItems: [{ type: "string" }],
        items: { type: "boolean" },
      }),
    ).toStrictEqual({
      kind: "tuple",
      items: [{ kind: "scalar", name: "string" }],
      rest: { kind: "scalar", name: "boolean" },
    })
    expect(buildContractType({ type: "array", prefixItems: [{ type: "string" }] })).toStrictEqual({
      kind: "tuple",
      items: [{ kind: "scalar", name: "string" }],
    })
    expect(
      buildContractType({ type: "array", prefixItems: [{ type: "string" }], items: true }),
    ).toStrictEqual({
      kind: "tuple",
      items: [{ kind: "scalar", name: "string" }],
      rest: unknown,
    })
  })
})

describe("buildContractType: objects", () => {
  it("maps properties to fields with requiredness and docs", () => {
    expect(
      buildContractType({
        type: "object",
        properties: {
          id: { type: "number", description: "Identifier." },
          name: { type: "string" },
        },
        required: ["id"],
      }),
    ).toStrictEqual({
      kind: "object",
      fields: [
        {
          name: "id",
          required: true,
          type: { kind: "scalar", name: "number" },
          docs: { description: "Identifier." },
        },
        { name: "name", required: false, type: { kind: "scalar", name: "string" } },
      ],
    })
  })

  it("maps objects without properties to records", () => {
    expect(buildContractType({ type: "object" })).toStrictEqual({ kind: "record", values: unknown })
    expect(
      buildContractType({ type: "object", additionalProperties: { type: "string" } }),
    ).toStrictEqual({ kind: "record", values: { kind: "scalar", name: "string" } })
  })

  it("keeps the index type unwidened beside declared fields", () => {
    expect(
      buildContractType({
        type: "object",
        properties: { id: { type: "number" } },
        additionalProperties: { type: "string" },
      }),
    ).toStrictEqual({
      kind: "object",
      fields: [{ name: "id", required: false, type: { kind: "scalar", name: "number" } }],
      index: { kind: "scalar", name: "string" },
    })
  })

  it("maps additionalProperties: true to an unknown index", () => {
    expect(
      buildContractType({
        type: "object",
        properties: { id: { type: "number" } },
        additionalProperties: true,
      }),
    ).toStrictEqual({
      kind: "object",
      fields: [{ name: "id", required: false, type: { kind: "scalar", name: "number" } }],
      index: unknown,
    })
  })

  it("unions patternProperties with schema-valued additionalProperties", () => {
    expect(
      buildContractType({
        type: "object",
        properties: { id: { type: "number" } },
        patternProperties: { "^x-": { type: "string" } },
        additionalProperties: { type: "boolean" },
      }),
    ).toStrictEqual({
      kind: "object",
      fields: [{ name: "id", required: false, type: { kind: "scalar", name: "number" } }],
      index: {
        kind: "union",
        members: [
          { kind: "scalar", name: "string" },
          { kind: "scalar", name: "boolean" },
        ],
      },
    })
  })
})
