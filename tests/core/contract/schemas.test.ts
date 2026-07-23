import { describe, expect, it } from "vitest"
import { buildContract } from "../../../src/core/contract/build"
import { BuildError } from "../../../src/core/contract/errors"

describe("contract: schema models", () => {
  it("object schema becomes interface model with contract type fields", () => {
    const contract = buildContract({
      components: {
        schemas: {
          User: {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" } },
            required: ["id"],
          },
        },
      },
    })

    expect(contract.schemas).toStrictEqual([
      {
        name: "User",
        originalName: "User",
        kind: "interface",
        source: { location: "/components/schemas/User" },
        fields: [
          {
            name: "id",
            required: true,
            type: { kind: "scalar", name: "number" },
          },
          {
            name: "name",
            required: false,
            type: { kind: "scalar", name: "string" },
          },
        ],
      },
    ])
  })

  it("non-object schema becomes alias model with a contract type", () => {
    const contract = buildContract({
      components: { schemas: { Status: { enum: ["a", "b"] } } },
    })

    expect(contract.schemas[0]).toMatchObject({
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
    })
  })

  it("sanitizes names and preserves originalName", () => {
    const contract = buildContract({
      components: { schemas: { "Folder/User": { type: "object" } } },
    })
    expect(contract.schemas[0]).toMatchObject({
      name: "Folder_User",
      originalName: "Folder/User",
    })
  })

  it("throws BuildError on schema name collision after sanitization", () => {
    expect(() =>
      buildContract({
        components: {
          schemas: {
            "User-Profile": { type: "object" },
            "User_Profile": { type: "object" },
          },
        },
      }),
    ).toThrow(BuildError)
  })

  it("interface schema carries an index type for patternProperties and additionalProperties", () => {
    const contract = buildContract({
      components: {
        schemas: {
          Bag: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            patternProperties: { "^x_": { type: "number" } },
            additionalProperties: { type: "boolean" },
          },
        },
      },
    })

    expect(contract.schemas[0]).toMatchObject({
      kind: "interface",
      fields: [
        {
          name: "id",
          required: true,
          type: { kind: "scalar", name: "string" },
        },
      ],
      index: {
        kind: "union",
        members: [
          { kind: "scalar", name: "number" },
          { kind: "scalar", name: "boolean" },
        ],
      },
    })
  })
})
