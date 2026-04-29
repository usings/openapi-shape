import { describe, expect, it } from "vitest";
import { injectDiscriminators } from "../src/discriminator";

function expectConst(out: any, schema: string, prop: string, value: string): void {
  expect(out.components.schemas[schema].properties[prop]).toEqual({ const: value });
}

describe("injectDiscriminators", () => {
  describe("oneOf + mapping (happy path)", () => {
    it("injects const literal into each branch schema via mapping", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: { purr: { type: "string" } } },
            Dog: { type: "object", properties: { bark: { type: "string" } } },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
              discriminator: {
                propertyName: "type",
                mapping: {
                  cat: "#/components/schemas/Cat",
                  dog: "#/components/schemas/Dog",
                },
              },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
      expectConst(out, "Dog", "type", "dog");
      expect(out.components.schemas.Cat.required).toContain("type");
      expect(out.components.schemas.Dog.required).toContain("type");
    });

    it("returns doc unchanged when no discriminator is present", () => {
      const doc = {
        components: { schemas: { Foo: { type: "object", properties: {} } } },
      };
      const out = injectDiscriminators(doc);
      expect(out).toBe(doc);
    });
  });

  describe("anyOf and mapping variations", () => {
    it("treats anyOf the same as oneOf", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Dog: { type: "object", properties: {} },
            Animal: {
              anyOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
              discriminator: {
                propertyName: "type",
                mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
              },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
      expectConst(out, "Dog", "type", "dog");
    });

    it("infers value from schema name when mapping is omitted", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Dog: { type: "object", properties: {} },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
              discriminator: { propertyName: "type" },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "Cat");
      expectConst(out, "Dog", "type", "Dog");
    });

    it("accepts bare schema name as mapping value", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
    });

    it("falls back to schema name for branches not in partial mapping", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Dog: { type: "object", properties: {} },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
      expectConst(out, "Dog", "type", "Dog");
    });
  });

  describe("existing property handling", () => {
    function singleUnion(catSchema: any) {
      return {
        components: {
          schemas: {
            Cat: catSchema,
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
    }

    it("narrows an existing string property to a const literal", () => {
      const doc = singleUnion({
        type: "object",
        properties: { type: { type: "string" }, name: { type: "string" } },
      });
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
      expect(out.components.schemas.Cat.properties.name).toEqual({ type: "string" });
    });

    it("is a no-op when the existing const matches the discriminator value", () => {
      const doc = singleUnion({
        type: "object",
        properties: { type: { const: "cat" } },
        required: ["type"],
      });
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
      expect(out.components.schemas.Cat.required).toEqual(["type"]);
    });

    it("does not duplicate propertyName when already in required", () => {
      const doc = singleUnion({
        type: "object",
        properties: { type: { type: "string" } },
        required: ["type"],
      });
      const out = injectDiscriminators(doc);
      expect(out.components.schemas.Cat.required.filter((r: string) => r === "type")).toHaveLength(
        1,
      );
    });

    it("throws when an existing const has a different value", () => {
      const doc = singleUnion({
        type: "object",
        properties: { type: { const: "dog" } },
      });
      expect(() => injectDiscriminators(doc)).toThrow(
        /Discriminator conflict in schema "Cat".*declared as const "dog".*"cat"/,
      );
    });

    it("throws when an existing property has a non-string type", () => {
      const doc = singleUnion({
        type: "object",
        properties: { type: { type: "number" } },
      });
      expect(() => injectDiscriminators(doc)).toThrow(
        /Discriminator conflict in schema "Cat".*type "number".*"cat"/,
      );
    });

    it("narrows a single-element matching enum to a const literal", () => {
      const doc = singleUnion({
        type: "object",
        properties: { type: { type: "string", enum: ["cat"] } },
      });
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
    });

    it("narrows a multi-value enum that contains the discriminator value", () => {
      const doc = singleUnion({
        type: "object",
        properties: { type: { type: "string", enum: ["cat", "feline"] } },
      });
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
    });

    it("throws when the existing enum does not include the discriminator value", () => {
      const doc = singleUnion({
        type: "object",
        properties: { type: { type: "string", enum: ["dog"] } },
      });
      expect(() => injectDiscriminators(doc)).toThrow(
        /Discriminator conflict in schema "Cat".*enum \["dog"\].*"cat"/,
      );
    });
  });

  describe("multi-union scenarios", () => {
    it("is idempotent when the same schema is referenced from two unions with same field+value", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Dog: { type: "object", properties: {} },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat", dog: "Dog" } },
            },
            HouseAnimal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
    });

    it("throws when same schema is referenced with same field but different values", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
            Pet: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { feline: "Cat" } },
            },
          },
        },
      };
      expect(() => injectDiscriminators(doc)).toThrow(
        /Discriminator value conflict for "Cat\.type".*"cat".*"feline"/,
      );
    });

    it("injects different fields on the same schema referenced from two unions", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
            Pet: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "kind", mapping: { feline: "Cat" } },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
      expectConst(out, "Cat", "kind", "feline");
      expect(out.components.schemas.Cat.required).toEqual(expect.arrayContaining(["type", "kind"]));
    });
  });

  describe("spec errors", () => {
    it("throws when a branch is an inline schema (not $ref)", () => {
      const doc = {
        components: {
          schemas: {
            Animal: {
              oneOf: [{ type: "object", properties: { kind: { type: "string" } } }],
              discriminator: { propertyName: "type" },
            },
          },
        },
      };
      expect(() => injectDiscriminators(doc)).toThrow(
        /discriminator branch must be \$ref.*got inline schema/,
      );
    });

    it("throws when a branch $ref points outside components.schemas", () => {
      const doc = {
        components: {
          parameters: { Foo: { name: "x", in: "query", schema: { type: "string" } } },
          schemas: {
            Animal: {
              oneOf: [{ $ref: "#/components/parameters/Foo" }],
              discriminator: { propertyName: "type" },
            },
          },
        },
      };
      expect(() => injectDiscriminators(doc)).toThrow(
        /discriminator branch \$ref must point to components\.schemas/,
      );
    });

    it("throws when a branch $ref points to a nonexistent schema", () => {
      const doc = {
        components: {
          schemas: {
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Nope" }],
              discriminator: { propertyName: "type", mapping: { nope: "Nope" } },
            },
          },
        },
      };
      expect(() => injectDiscriminators(doc)).toThrow(
        /Discriminator branch references unknown schema "Nope"/,
      );
    });

    it("injects into an existing allOf inline object member", () => {
      const doc = {
        components: {
          schemas: {
            Base: { type: "object", properties: { id: { type: "string" } } },
            Cat: {
              allOf: [
                { $ref: "#/components/schemas/Base" },
                { type: "object", properties: { purr: { type: "string" } } },
              ],
            },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expect(out.components.schemas.Cat.allOf[1]).toEqual({
        type: "object",
        properties: { purr: { type: "string" }, type: { const: "cat" } },
        required: ["type"],
      });
    });

    it("appends an allOf inline object member when none can receive the discriminator", () => {
      const doc = {
        components: {
          schemas: {
            Base: { type: "object", properties: { id: { type: "string" } } },
            Cat: { allOf: [{ $ref: "#/components/schemas/Base" }] },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expect(out.components.schemas.Cat.allOf).toEqual([
        { $ref: "#/components/schemas/Base" },
        {
          type: "object",
          properties: { type: { const: "cat" } },
          required: ["type"],
        },
      ]);
    });

    it("throws when an allOf inline object member has a conflicting discriminator property", () => {
      const doc = {
        components: {
          schemas: {
            Base: { type: "object", properties: { id: { type: "string" } } },
            Cat: {
              allOf: [
                { $ref: "#/components/schemas/Base" },
                { type: "object", properties: { type: { const: "dog" } } },
              ],
            },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      expect(() => injectDiscriminators(doc)).toThrow(
        /Discriminator conflict in schema "Cat".*declared as const "dog".*"cat"/,
      );
    });

    it("throws when the branch target is not an object type", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "string" },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      expect(() => injectDiscriminators(doc)).toThrow(
        /Cannot inject discriminator into "Cat": schema is not an object type \(got "string"\)/,
      );
    });
  });

  describe("walk scope, idempotence, immutability", () => {
    it("processes a discriminator inline inside an operation's response schema", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Dog: { type: "object", properties: {} },
          },
        },
        paths: {
          "/animals": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        oneOf: [
                          { $ref: "#/components/schemas/Cat" },
                          { $ref: "#/components/schemas/Dog" },
                        ],
                        discriminator: {
                          propertyName: "type",
                          mapping: { cat: "Cat", dog: "Dog" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };
      const out = injectDiscriminators(doc);
      expectConst(out, "Cat", "type", "cat");
      expectConst(out, "Dog", "type", "dog");
    });

    it("is idempotent (calling twice yields the same result)", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: {} },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      const once = injectDiscriminators(doc);
      const twice = injectDiscriminators(once);
      expect(twice).toEqual(once);
    });

    it("does not mutate the input doc", () => {
      const doc = {
        components: {
          schemas: {
            Cat: { type: "object", properties: { purr: { type: "string" } } },
            Animal: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }],
              discriminator: { propertyName: "type", mapping: { cat: "Cat" } },
            },
          },
        },
      };
      const before = JSON.parse(JSON.stringify(doc));
      injectDiscriminators(doc);
      expect(doc).toEqual(before);
    });
  });
});
