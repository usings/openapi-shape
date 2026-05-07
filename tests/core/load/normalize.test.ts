import { describe, expect, it } from "vitest";
import { normalize } from "../../../src/core/load/normalize";
import { LoadError } from "../../../src/core/shared/errors";

describe("normalize: version handling", () => {
  it.each(["3.2.0", "2.0"])("throws LoadError on unsupported version %s", (version) => {
    expect(() => normalize({ openapi: version })).toThrow(LoadError);
  });

  it("throws LoadError when input is not an object", () => {
    expect(() => normalize(null)).toThrow(LoadError);
    expect(() => normalize("hi")).toThrow(LoadError);
    expect(() => normalize(42)).toThrow(LoadError);
  });
});

describe("normalize: 3.0 nullable rewrite", () => {
  it("rewrites nullable: true on string", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: { schemas: { X: { type: "string", nullable: true } } },
    });
    expect(out.components?.schemas?.X).toEqual({ type: ["string", "null"] });
  });

  it("rewrites nested nullable inside properties", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: {
          X: {
            type: "object",
            properties: { a: { type: "integer", nullable: true } },
          },
        },
      },
    });
    expect(out.components?.schemas?.X?.properties?.a).toEqual({
      type: ["integer", "null"],
    });
  });

  it("walks into oneOf/anyOf/allOf branches", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: {
          X: {
            oneOf: [{ type: "string", nullable: true }, { type: "integer" }],
          },
        },
      },
    });
    expect(out.components?.schemas?.X?.oneOf?.[0]).toEqual({
      type: ["string", "null"],
    });
  });

  it("walks into items and prefixItems", () => {
    const out = normalize({
      openapi: "3.0.3",
      components: {
        schemas: {
          X: { type: "array", items: { type: "string", nullable: true } },
          Y: {
            type: "array",
            prefixItems: [{ type: "string", nullable: true }],
          },
        },
      },
    });
    expect(out.components?.schemas?.X?.items).toEqual({ type: ["string", "null"] });
    expect(out.components?.schemas?.Y?.prefixItems?.[0]).toEqual({
      type: ["string", "null"],
    });
  });

  it("does NOT rewrite nullable on object/array (out of scope)", () => {
    const input = {
      openapi: "3.0.3",
      components: { schemas: { X: { type: "object", nullable: true, properties: {} } } },
    };
    const out = normalize(input);
    expect(out.components?.schemas?.X).toEqual({
      type: "object",
      nullable: true,
      properties: {},
    });
  });

  it("structural sharing: untouched subtree preserved by reference", () => {
    const inner = { type: "object", properties: { a: { type: "string" } } };
    const out = normalize({
      openapi: "3.0.3",
      components: { schemas: { X: inner } },
    });
    expect(out.components?.schemas?.X).toBe(inner);
  });

  it("rewrites nullable in parameter schemas (path/query)", () => {
    const out = normalize({
      openapi: "3.0.3",
      paths: {
        "/x": {
          get: {
            parameters: [{ name: "id", in: "query", schema: { type: "string", nullable: true } }],
            responses: {},
          },
        },
      },
    });
    expect(out.paths?.["/x"]?.get?.parameters?.[0]?.schema).toEqual({
      type: ["string", "null"],
    });
  });

  it("rewrites nullable in request body schemas", () => {
    const out = normalize({
      openapi: "3.0.3",
      paths: {
        "/x": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "string", nullable: true },
                },
              },
            },
            responses: {},
          },
        },
      },
    });
    expect(out.paths?.["/x"]?.post?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: ["string", "null"],
    });
  });
});
