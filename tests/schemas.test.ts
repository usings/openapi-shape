import { describe, expect, it } from "vitest";
import { schemaToType, generateSchemas } from "../src/schemas";

describe("schemaToType", () => {
  it.each([
    ["string", "string"],
    ["number", "number"],
    ["integer", "number"],
    ["boolean", "boolean"],
  ])("converts primitive %s → %s", (type, expected) => {
    expect(schemaToType({ type })).toBe(expected);
  });

  it("converts array", () => {
    expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("string[]");
  });

  it("converts array of objects wraps in parens", () => {
    expect(
      schemaToType({
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
      }),
    ).toBe("{\n  id: number\n}[]");
  });

  it("converts $ref to type name", () => {
    expect(schemaToType({ $ref: "#/components/schemas/Task" })).toBe("Task");
  });

  it("converts object with required and optional properties", () => {
    const result = schemaToType({
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        tag: { type: "string" },
      },
      required: ["id", "name"],
    });
    expect(result).toBe("{\n  id: number\n  name: string\n  tag?: string\n}");
  });

  it("converts object with additionalProperties", () => {
    expect(
      schemaToType({
        type: "object",
        additionalProperties: { type: "string" },
      }),
    ).toBe("Record<string, string>");
  });

  it("preserves explicit properties when additionalProperties is a schema", () => {
    expect(
      schemaToType({
        type: "object",
        properties: {
          id: { type: "number" },
          label: { type: "string" },
        },
        required: ["id"],
        additionalProperties: { type: "string" },
      }),
    ).toBe("{\n  id: number\n  label?: string\n  [key: string]: string | number | undefined\n}");
  });

  it("converts empty object to Record<string, unknown>", () => {
    expect(schemaToType({ type: "object" })).toBe("Record<string, unknown>");
  });

  it("converts oneOf to union", () => {
    expect(
      schemaToType({
        oneOf: [{ type: "string" }, { type: "number" }],
      }),
    ).toBe("string | number");
  });

  it("converts anyOf to union", () => {
    expect(
      schemaToType({
        anyOf: [{ type: "string" }, { type: "boolean" }],
      }),
    ).toBe("string | boolean");
  });

  it("converts allOf to intersection", () => {
    expect(
      schemaToType({
        allOf: [{ $ref: "#/components/schemas/Base" }, { $ref: "#/components/schemas/Extra" }],
      }),
    ).toBe("Base & Extra");
  });

  it("handles nullable (3.0)", () => {
    expect(schemaToType({ type: "string", nullable: true })).toBe("string | null");
  });

  it("handles type array with null (3.1)", () => {
    expect(schemaToType({ type: ["string", "null"] })).toBe("string | null");
  });

  it("returns unknown for missing schema", () => {
    expect(schemaToType(undefined)).toBe("unknown");
    expect(schemaToType({})).toBe("unknown");
  });

  it("wraps union items in parens for array", () => {
    expect(
      schemaToType({
        type: "array",
        items: { oneOf: [{ type: "string" }, { type: "number" }] },
      }),
    ).toBe("(string | number)[]");
  });

  it("handles object with properties and additionalProperties: true", () => {
    expect(
      schemaToType({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: true,
      }),
    ).toBe("{\n  name: string\n}");
  });

  it("quotes property names that are not valid identifiers", () => {
    const result = schemaToType({
      type: "object",
      properties: {
        "user-id": { type: "string" },
        class: { type: "boolean" },
      },
      required: ["user-id"],
    });
    expect(result).toBe('{\n  "user-id": string\n  class?: boolean\n}');
  });

  it("sanitizes $ref last segment to match sanitized decl name", () => {
    expect(schemaToType({ $ref: "#/components/schemas/User-Profile" })).toBe("User_Profile");
    expect(schemaToType({ $ref: "#/components/schemas/123Foo" })).toBe("_123Foo");
  });

  describe("const", () => {
    it("emits string literal for string const", () => {
      expect(schemaToType({ const: "active" })).toBe('"active"');
    });
    it("emits number literal for number const", () => {
      expect(schemaToType({ const: 42 })).toBe("42");
    });
    it("emits boolean literal for boolean const", () => {
      expect(schemaToType({ const: true })).toBe("true");
      expect(schemaToType({ const: false })).toBe("false");
    });
    it("emits null literal for null const", () => {
      expect(schemaToType({ const: null })).toBe("null");
    });
    it("falls back to unknown for object/array const", () => {
      expect(schemaToType({ const: { a: 1 } })).toBe("unknown");
      expect(schemaToType({ const: [1, 2] })).toBe("unknown");
    });
  });

  describe("enum", () => {
    it("emits string union for string enum", () => {
      expect(schemaToType({ type: "string", enum: ["a", "b", "c"] })).toBe('"a" | "b" | "c"');
    });

    it("emits number union for numeric enum", () => {
      expect(schemaToType({ type: "integer", enum: [1, 2, 3] })).toBe("1 | 2 | 3");
    });

    it("emits boolean union for boolean enum", () => {
      expect(schemaToType({ type: "boolean", enum: [true, false] })).toBe("true | false");
    });

    it("emits null literal in mixed enum", () => {
      expect(schemaToType({ enum: ["a", null] })).toBe('"a" | null');
    });

    it("emits mixed-type union", () => {
      expect(schemaToType({ enum: ["a", 1, true] })).toBe('"a" | 1 | true');
    });

    it("emits single literal for single-value enum", () => {
      expect(schemaToType({ enum: ["only"] })).toBe('"only"');
    });

    it("falls back to unknown for object/array enum entries", () => {
      expect(schemaToType({ enum: [{ a: 1 }] })).toBe("unknown");
    });

    it("applies enum union to inline nested property", () => {
      expect(
        schemaToType({
          type: "object",
          properties: { kind: { type: "string", enum: ["new", "done"] } },
          required: ["kind"],
        }),
      ).toBe('{\n  kind: "new" | "done"\n}');
    });
  });

  describe("prefixItems", () => {
    it("emits closed tuple when items is undefined", () => {
      expect(
        schemaToType({
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
        }),
      ).toBe("[string, number]");
    });

    it("emits closed tuple when items is false", () => {
      expect(
        schemaToType({
          type: "array",
          prefixItems: [{ type: "string" }],
          items: false,
        }),
      ).toBe("[string]");
    });

    it("emits tuple with rest when items is a schema", () => {
      expect(
        schemaToType({
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "number" },
        }),
      ).toBe("[string, ...number[]]");
    });

    it("emits tuple with unknown rest when items is true", () => {
      expect(
        schemaToType({
          type: "array",
          prefixItems: [{ type: "string" }],
          items: true,
        }),
      ).toBe("[string, ...unknown[]]");
    });
  });
});

describe("generateSchemas", () => {
  it("generates interface for object schema", () => {
    const schemas = {
      Task: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
        },
        required: ["id", "title"],
      },
    };
    const result = generateSchemas(schemas);
    expect(result).toBe("export interface Task {\n  id: number\n  title: string\n}");
  });

  it("generates type alias for non-object schema", () => {
    const schemas = {
      TaskId: { type: "string" },
    };
    const result = generateSchemas(schemas);
    expect(result).toBe("export type TaskId = string");
  });

  it("generates union type alias for string enum", () => {
    const schemas = {
      Status: {
        type: "string",
        enum: ["active", "inactive"],
      },
    };
    const result = generateSchemas(schemas);
    expect(result).toBe('export type Status = "active" | "inactive"');
  });

  it("generates union type alias for numeric enum", () => {
    const schemas = {
      Priority: {
        type: "integer",
        enum: [1, 2, 3],
      },
    };
    const result = generateSchemas(schemas);
    expect(result).toBe("export type Priority = 1 | 2 | 3");
  });

  it("emits literal values verbatim for string enum (no key sanitization needed)", () => {
    const schemas = {
      Status: {
        type: "string",
        enum: ["in-progress", "done"],
      },
    };
    const result = generateSchemas(schemas);
    expect(result).toBe('export type Status = "in-progress" | "done"');
  });

  it("generates interface when additionalProperties is true", () => {
    const schemas = {
      Foo: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: true,
      },
    };
    const result = generateSchemas(schemas);
    expect(result).toBe("export interface Foo {\n  id: number\n}");
  });

  it("joins multiple schemas with double newline", () => {
    const schemas = {
      A: { type: "string" },
      B: { type: "number" },
    };
    const result = generateSchemas(schemas);
    expect(result).toBe("export type A = string\n\nexport type B = number");
  });

  it("emits JSDoc above an interface from schema description", () => {
    const result = generateSchemas({
      Pet: {
        type: "object",
        description: "A domesticated animal",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    });
    expect(result).toBe("/** A domesticated animal */\nexport interface Pet {\n  id: number\n}");
  });

  it("emits JSDoc above a property from property description", () => {
    const result = generateSchemas({
      Pet: {
        type: "object",
        properties: {
          id: { type: "number", description: "Unique pet identifier" },
          name: { type: "string" },
        },
        required: ["id"],
      },
    });
    expect(result).toContain("/** Unique pet identifier */\n  id: number");
    expect(result).toContain("  name?: string");
  });

  it("marks deprecated schemas with @deprecated", () => {
    const result = generateSchemas({
      OldThing: { type: "string", deprecated: true },
    });
    expect(result).toBe("/** @deprecated */\nexport type OldThing = string");
  });
});

describe("generateSchemas sanitization", () => {
  it("sanitizes top-level decl names with illegal characters", () => {
    const result = generateSchemas({
      "User-Profile": { type: "object", properties: { name: { type: "string" } } },
    });
    expect(result).toContain("export interface User_Profile");
  });

  it("prefixes underscore for names starting with a digit", () => {
    const result = generateSchemas({
      "123Foo": { type: "string" },
    });
    expect(result).toContain("export type _123Foo = string");
  });

  it("prefixes underscore for reserved words in top-level decl names", () => {
    const result = generateSchemas({
      class: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      default: { type: "string" },
    });
    expect(result).toContain("export interface _class");
    expect(result).toContain("export type _default = string");
  });

  it("sanitizes $ref names that point to reserved words", () => {
    expect(schemaToType({ $ref: "#/components/schemas/class" })).toBe("_class");
  });

  it("throws when two original names sanitize to the same identifier", () => {
    expect(() =>
      generateSchemas({
        "User-Profile": { type: "object", properties: {} },
        User_Profile: { type: "object", properties: {} },
      }),
    ).toThrow(/User-Profile.*User_Profile/);
  });
});
