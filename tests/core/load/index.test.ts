import { describe, expect, it } from "vitest";
import { loadDocument, prepareDocument } from "../../../src/core/load";
import { LoadError } from "../../../src/core/load/errors";
import { withTmpFile } from "../../_helpers/tmp";

describe("loadDocument: I/O", () => {
  it("reads, normalizes, resolves refs, and injects discriminators end-to-end", async () => {
    await withTmpFile(
      JSON.stringify({
        openapi: "3.0.3",
        components: {
          schemas: {
            X: { type: "string", nullable: true },
          },
          parameters: {
            Limit: { name: "limit", in: "query", schema: { type: "integer" } },
          },
        },
        paths: {
          "/x": {
            get: {
              parameters: [{ $ref: "#/components/parameters/Limit" }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
      async (path) => {
        const doc = await loadDocument(path);
        expect(doc.components?.schemas?.X).toEqual({ type: ["string", "null"] });
        expect(doc.paths?.["/x"]?.get?.parameters?.[0]).toEqual({
          name: "limit",
          in: "query",
          schema: { type: "integer" },
        });
      },
    );
  });

  it("throws LoadError when file is missing", async () => {
    await expect(loadDocument("/tmp/does-not-exist-xyz.json")).rejects.toBeInstanceOf(LoadError);
  });

  it("throws LoadError on invalid JSON", async () => {
    await withTmpFile("{ not json }", async (path) => {
      await expect(loadDocument(path)).rejects.toBeInstanceOf(LoadError);
    });
  });

  it("accepts a file:// URL", async () => {
    await withTmpFile(JSON.stringify({ openapi: "3.1.0", info: { title: "U" } }), async (path) => {
      const doc = await loadDocument(new URL(`file://${path}`));
      expect(doc.info?.title).toBe("U");
    });
  });

  it("throws LoadError on unsupported URL protocol (e.g. ftp:)", async () => {
    await expect(loadDocument(new URL("ftp://example.com/openapi.json"))).rejects.toBeInstanceOf(
      LoadError,
    );
  });
});

describe("prepareDocument: refs", () => {
  it("resolves component parameter ref at operation level", () => {
    const out = prepareDocument({
      components: {
        parameters: {
          Limit: { name: "limit", in: "query", schema: { type: "integer" } },
        },
      },
      paths: {
        "/x": {
          get: {
            parameters: [{ $ref: "#/components/parameters/Limit" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(out.paths?.["/x"]?.get?.parameters?.[0]).toEqual({
      name: "limit",
      in: "query",
      schema: { type: "integer" },
    });
  });

  it("resolves requestBody ref", () => {
    const out = prepareDocument({
      components: {
        requestBodies: {
          B: { content: { "application/json": { schema: { type: "string" } } } },
        },
      },
      paths: {
        "/x": {
          post: {
            requestBody: { $ref: "#/components/requestBodies/B" },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(out.paths?.["/x"]?.post?.requestBody).toEqual({
      content: { "application/json": { schema: { type: "string" } } },
    });
  });

  it("throws LoadError on missing ref target", () => {
    expect(() =>
      prepareDocument({
        paths: {
          "/x": {
            get: {
              parameters: [{ $ref: "#/components/parameters/Missing" }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    ).toThrow(LoadError);
  });

  it("throws LoadError on circular ref", () => {
    expect(() =>
      prepareDocument({
        components: {
          parameters: {
            A: { $ref: "#/components/parameters/B" },
            B: { $ref: "#/components/parameters/A" },
          },
        },
        paths: {
          "/x": {
            get: {
              parameters: [{ $ref: "#/components/parameters/A" }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    ).toThrow(LoadError);
  });
});

describe("prepareDocument: discriminator", () => {
  it("injects literals into oneOf branches", () => {
    const out = prepareDocument({
      components: {
        schemas: {
          Cat: { type: "object", properties: { purr: { type: "string" } } },
          Dog: { type: "object", properties: { bark: { type: "string" } } },
          Animal: {
            oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
            discriminator: {
              propertyName: "type",
              mapping: { cat: "Cat", dog: "Dog" },
            },
          },
        },
      },
    });
    expect(out.components?.schemas?.Cat?.properties?.type).toEqual({ const: "cat" });
    expect(out.components?.schemas?.Dog?.properties?.type).toEqual({ const: "dog" });
  });

  it("throws LoadError on inline (non-$ref) branch", () => {
    expect(() =>
      prepareDocument({
        components: {
          schemas: {
            Animal: {
              oneOf: [{ type: "object" }],
              discriminator: { propertyName: "type" },
            },
          },
        },
      }),
    ).toThrow(LoadError);
  });
});

describe("prepareDocument: idempotence", () => {
  it("running twice yields equal result", () => {
    const input = {
      components: {
        schemas: {
          X: { type: "string", nullable: true },
        },
      },
    };
    const once = prepareDocument(input);
    const twice = prepareDocument(once);
    expect(twice).toEqual(once);
  });

  it("accepts in-memory doc with no openapi field", () => {
    expect(prepareDocument({})).toEqual({});
    expect(prepareDocument({ info: { title: "T", version: "1" } })).toEqual({
      info: { title: "T", version: "1" },
    });
  });

  it("normalizes webhook operation schemas through the public loader pipeline", () => {
    const out = prepareDocument({
      openapi: "3.0.3",
      webhooks: {
        event: {
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
    expect(out.webhooks?.event?.post?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: ["string", "null"],
    });
  });
});
