import { describe, expect, it } from "vitest";
import { buildIR } from "../../src/ir";
import { BuildError } from "../../src/errors";

describe("buildIR: info and empties", () => {
  it("empty doc → empty IR", () => {
    const ir = buildIR({});
    expect(ir).toEqual({ info: {}, schemas: [], endpoints: [] });
  });

  it("captures info fields", () => {
    const ir = buildIR({ info: { title: "T", version: "1.0", description: "D" } });
    expect(ir.info).toEqual({ title: "T", version: "1.0", description: "D" });
  });
});

describe("buildIR: schema kinds", () => {
  it("object schema → interface SchemaModel", () => {
    const ir = buildIR({
      components: {
        schemas: {
          User: {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" } },
            required: ["id"],
          },
        },
      },
    });
    expect(ir.schemas).toEqual([
      {
        name: "User",
        originalName: "User",
        kind: "interface",
        type: null,
        fields: [
          { name: "id", required: true, type: { kind: "primitive", name: "number" } },
          { name: "name", required: false, type: { kind: "primitive", name: "string" } },
        ],
      },
    ]);
  });

  it("non-object schema → alias SchemaModel", () => {
    const ir = buildIR({
      components: { schemas: { Status: { enum: ["a", "b"] } } },
    });
    expect(ir.schemas[0]).toEqual({
      name: "Status",
      originalName: "Status",
      kind: "alias",
      fields: null,
      type: {
        kind: "union",
        members: [
          { kind: "literal", value: "a" },
          { kind: "literal", value: "b" },
        ],
      },
    });
  });

  it("sanitizes name and preserves originalName", () => {
    const ir = buildIR({
      components: { schemas: { "User-Profile": { enum: ["a"] } } },
    });
    expect(ir.schemas[0].name).toBe("User_Profile");
    expect(ir.schemas[0].originalName).toBe("User-Profile");
  });

  it("throws BuildError on schema name collision after sanitization", () => {
    expect(() =>
      buildIR({
        components: {
          schemas: {
            "User-Profile": { type: "object" },
            User_Profile: { type: "object" },
          },
        },
      }),
    ).toThrow(BuildError);
  });
});

describe("buildIR: TypeNode coverage via schemas", () => {
  it("primitives string/number/boolean", () => {
    const ir = buildIR({
      components: {
        schemas: {
          A: { type: "string" },
          B: { type: "integer" },
          C: { type: "boolean" },
        },
      },
    });
    expect(ir.schemas[0].type).toEqual({ kind: "primitive", name: "string" });
    expect(ir.schemas[1].type).toEqual({ kind: "primitive", name: "number" });
    expect(ir.schemas[2].type).toEqual({ kind: "primitive", name: "boolean" });
  });

  it("type array with null → union", () => {
    const ir = buildIR({
      components: { schemas: { N: { type: ["string", "null"] } } },
    });
    expect(ir.schemas[0].type).toEqual({
      kind: "union",
      members: [
        { kind: "primitive", name: "string" },
        { kind: "primitive", name: "null" },
      ],
    });
  });

  it("$ref → ref TypeNode with sanitized name", () => {
    const ir = buildIR({
      components: {
        schemas: {
          A: { type: "object", properties: {} },
          B: { $ref: "#/components/schemas/A" },
        },
      },
    });
    expect(ir.schemas[1].type).toEqual({ kind: "ref", name: "A" });
  });

  it("array → array TypeNode", () => {
    const ir = buildIR({
      components: { schemas: { A: { type: "array", items: { type: "string" } } } },
    });
    expect(ir.schemas[0].type).toEqual({
      kind: "array",
      items: { kind: "primitive", name: "string" },
    });
  });

  it("tuple via prefixItems", () => {
    const ir = buildIR({
      components: {
        schemas: {
          A: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "number" }],
          },
        },
      },
    });
    expect(ir.schemas[0].type).toEqual({
      kind: "tuple",
      items: [
        { kind: "primitive", name: "string" },
        { kind: "primitive", name: "number" },
      ],
      rest: null,
    });
  });

  it("oneOf → union", () => {
    const ir = buildIR({
      components: {
        schemas: { A: { oneOf: [{ type: "string" }, { type: "number" }] } },
      },
    });
    expect(ir.schemas[0].type).toEqual({
      kind: "union",
      members: [
        { kind: "primitive", name: "string" },
        { kind: "primitive", name: "number" },
      ],
    });
  });

  it("allOf → intersection", () => {
    const ir = buildIR({
      components: {
        schemas: {
          A: {
            allOf: [
              { $ref: "#/components/schemas/B" },
              { type: "object", properties: { x: { type: "string" } } },
            ],
          },
          B: { type: "object", properties: {} },
        },
      },
    });
    expect(ir.schemas[0].type).toEqual({
      kind: "intersection",
      members: [
        { kind: "ref", name: "B" },
        {
          kind: "object",
          fields: [{ name: "x", required: false, type: { kind: "primitive", name: "string" } }],
          index: null,
        },
      ],
    });
  });

  it("format: binary → Blob (built-in)", () => {
    const ir = buildIR({
      components: { schemas: { A: { type: "string", format: "binary" } } },
    });
    expect(ir.schemas[0].type).toEqual({ kind: "primitive", name: "Blob" });
  });

  it("formats: date-time → raw('Date')", () => {
    const ir = buildIR(
      { components: { schemas: { A: { type: "string", format: "date-time" } } } },
      { formats: { "date-time": "Date" } },
    );
    expect(ir.schemas[0].type).toEqual({ kind: "raw", text: "Date" });
  });

  it("formats: user mapping wins over builtin binary→Blob", () => {
    const ir = buildIR(
      { components: { schemas: { A: { type: "string", format: "binary" } } } },
      { formats: { binary: "Buffer" } },
    );
    expect(ir.schemas[0].type).toEqual({ kind: "raw", text: "Buffer" });
  });

  it("formats: triggers on [string, null] + format", () => {
    const ir = buildIR(
      {
        components: {
          schemas: { A: { type: ["string", "null"], format: "date-time" } },
        },
      },
      { formats: { "date-time": "Date" } },
    );
    expect(ir.schemas[0].type).toEqual({
      kind: "union",
      members: [
        { kind: "raw", text: "Date" },
        { kind: "primitive", name: "null" },
      ],
    });
  });

  it("formats: ignored on object/array types", () => {
    const ir = buildIR(
      {
        components: {
          schemas: {
            Obj: { type: "object", format: "anything", properties: {} },
            Arr: { type: "array", format: "anything", items: { type: "string" } },
          },
        },
      },
      { formats: { anything: "Foo" } },
    );
    expect(ir.schemas[0].kind).toBe("interface");
    expect(ir.schemas[1].type).toEqual({
      kind: "array",
      items: { kind: "primitive", name: "string" },
    });
  });

  it("additionalProperties schema → record", () => {
    const ir = buildIR({
      components: {
        schemas: {
          A: { type: "object", additionalProperties: { type: "number" } },
        },
      },
    });
    expect(ir.schemas[0].type).toEqual({
      kind: "record",
      values: { kind: "primitive", name: "number" },
    });
  });

  it("const literal", () => {
    const ir = buildIR({
      components: { schemas: { A: { const: "hello" } } },
    });
    expect(ir.schemas[0].type).toEqual({ kind: "literal", value: "hello" });
  });
});
