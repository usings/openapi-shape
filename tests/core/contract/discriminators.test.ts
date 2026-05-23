import { describe, expect, it } from "vitest";
import {
  applyInjections,
  discoverInjections,
  reduceInjections,
} from "../../../src/core/contract/discriminators";
import type { Injection, SchemaInjections } from "../../../src/core/contract/discriminators";
import { LoadError } from "../../../src/core/contract/errors";

function injectionsOf(entries: Array<[string, string, string]>): SchemaInjections {
  const map: SchemaInjections = new Map();
  for (const [schemaName, propertyName, value] of entries) {
    let perSchema = map.get(schemaName);
    if (!perSchema) {
      perSchema = new Map();
      map.set(schemaName, perSchema);
    }
    perSchema.set(propertyName, { value, sourceLocation: "L" });
  }
  return map;
}

describe("discover: walks the document for discriminator branches", () => {
  it("emits one injection per oneOf branch with explicit mapping value", () => {
    const found = discoverInjections({
      components: {
        schemas: {
          Animal: {
            oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
            discriminator: { propertyName: "type", mapping: { cat: "Cat", dog: "Dog" } },
          },
          Cat: { type: "object" },
          Dog: { type: "object" },
        },
      },
    });
    expect(found).toStrictEqual([
      {
        schemaName: "Cat",
        propertyName: "type",
        value: "cat",
        sourceLocation: "/components/schemas/Animal/oneOf[0]",
      },
      {
        schemaName: "Dog",
        propertyName: "type",
        value: "dog",
        sourceLocation: "/components/schemas/Animal/oneOf[1]",
      },
    ]);
  });

  it("also walks anyOf branches", () => {
    const found = discoverInjections({
      components: {
        schemas: {
          X: {
            anyOf: [{ $ref: "#/components/schemas/A" }],
            discriminator: { propertyName: "kind" },
          },
          A: { type: "object" },
        },
      },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ schemaName: "A", propertyName: "kind", value: "A" });
  });

  it("falls back to schemaName when mapping does not match the branch ref", () => {
    const found = discoverInjections({
      components: {
        schemas: {
          X: {
            oneOf: [{ $ref: "#/components/schemas/A" }],
            discriminator: { propertyName: "kind", mapping: { other: "Z" } },
          },
          A: { type: "object" },
        },
      },
    });
    expect(found[0].value).toBe("A");
  });

  it("throws when a branch is an inline schema rather than $ref", () => {
    expect(() =>
      discoverInjections({
        components: {
          schemas: {
            X: {
              oneOf: [{ type: "object" }],
              discriminator: { propertyName: "kind" },
            },
          },
        },
      }),
    ).toThrow(LoadError);
  });

  it("throws when a branch $ref points outside components.schemas", () => {
    expect(() =>
      discoverInjections({
        components: {
          schemas: {
            X: {
              oneOf: [{ $ref: "#/components/responses/SomeResponse" }],
              discriminator: { propertyName: "kind" },
            },
          },
        },
      }),
    ).toThrow(LoadError);
  });

  it("ignores nodes without a discriminator", () => {
    const found = discoverInjections({
      components: { schemas: { Plain: { type: "object" } } },
    });
    expect(found).toStrictEqual([]);
  });
});

describe("reduce: folds Injection[] into a schema-keyed accumulator", () => {
  it("groups injections by schemaName then propertyName", () => {
    const list: Injection[] = [
      { schemaName: "A", propertyName: "kind", value: "a", sourceLocation: "L1" },
      { schemaName: "B", propertyName: "kind", value: "b", sourceLocation: "L2" },
    ];
    const map = reduceInjections(list);
    expect(map.get("A")?.get("kind")).toStrictEqual({ value: "a", sourceLocation: "L1" });
    expect(map.get("B")?.get("kind")).toStrictEqual({ value: "b", sourceLocation: "L2" });
  });

  it("accepts duplicate injections that agree on value", () => {
    const list: Injection[] = [
      { schemaName: "A", propertyName: "kind", value: "a", sourceLocation: "L1" },
      { schemaName: "A", propertyName: "kind", value: "a", sourceLocation: "L2" },
    ];
    expect(() => reduceInjections(list)).not.toThrow();
  });

  it("throws on value conflict for the same schema.property", () => {
    const list: Injection[] = [
      { schemaName: "A", propertyName: "kind", value: "x", sourceLocation: "L1" },
      { schemaName: "A", propertyName: "kind", value: "y", sourceLocation: "L2" },
    ];
    expect(() => reduceInjections(list)).toThrow(LoadError);
  });
});

describe("apply: produces a new document with literals injected", () => {
  it("returns the same doc when there are no injections", () => {
    const doc = { components: { schemas: { A: { type: "object" } } } };
    expect(applyInjections(doc, new Map())).toBe(doc);
  });

  it("injects const + required into a plain object schema", () => {
    const out = applyInjections(
      {
        components: { schemas: { A: { type: "object", properties: { id: { type: "string" } } } } },
      },
      injectionsOf([["A", "kind", "a"]]),
    );
    expect(out.components?.schemas?.A).toStrictEqual({
      type: "object",
      properties: { id: { type: "string" }, kind: { const: "a" } },
      required: ["kind"],
    });
  });

  it("injects into an allOf member that can receive a discriminator", () => {
    const out = applyInjections(
      {
        components: {
          schemas: {
            A: {
              allOf: [
                { $ref: "#/components/schemas/Base" },
                { type: "object", properties: { foo: { type: "string" } } },
              ],
            },
          },
        },
      },
      injectionsOf([["A", "kind", "a"]]),
    );
    const allOf = out.components?.schemas?.A.allOf as Array<Record<string, unknown>>;
    expect(allOf[1]).toMatchObject({
      type: "object",
      properties: { foo: { type: "string" }, kind: { const: "a" } },
      required: ["kind"],
    });
  });

  it("appends a new allOf member when none can receive the discriminator", () => {
    const out = applyInjections(
      {
        components: {
          schemas: {
            A: { allOf: [{ $ref: "#/components/schemas/Base" }] },
          },
        },
      },
      injectionsOf([["A", "kind", "a"]]),
    );
    const allOf = out.components?.schemas?.A.allOf as Array<Record<string, unknown>>;
    expect(allOf).toHaveLength(2);
    expect(allOf[1]).toStrictEqual({
      type: "object",
      properties: { kind: { const: "a" } },
      required: ["kind"],
    });
  });

  it("throws when an injection targets a schema not in components.schemas", () => {
    expect(() =>
      applyInjections({ components: { schemas: {} } }, injectionsOf([["Missing", "kind", "a"]])),
    ).toThrow(LoadError);
  });

  it("throws when injection value conflicts with an existing const property", () => {
    expect(() =>
      applyInjections(
        {
          components: {
            schemas: {
              A: { type: "object", properties: { kind: { const: "other" } } },
            },
          },
        },
        injectionsOf([["A", "kind", "a"]]),
      ),
    ).toThrow(LoadError);
  });

  it("throws when injection value is absent from an existing enum property", () => {
    expect(() =>
      applyInjections(
        {
          components: {
            schemas: {
              A: { type: "object", properties: { kind: { enum: ["b", "c"] } } },
            },
          },
        },
        injectionsOf([["A", "kind", "a"]]),
      ),
    ).toThrow(LoadError);
  });

  it("throws when target schema is not an object type", () => {
    expect(() =>
      applyInjections(
        { components: { schemas: { A: { type: "string" } } } },
        injectionsOf([["A", "kind", "a"]]),
      ),
    ).toThrow(LoadError);
  });
});
