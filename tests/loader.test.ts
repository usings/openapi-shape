// tests/loader.test.ts
import { describe, expect, it } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { loadDocument, prepareDocument } from "../src/loader";
import { LoadError, BuildError } from "../src/errors";

describe("loadDocument: I/O", () => {
  it("reads, normalizes, resolves refs, and injects discriminators end-to-end", async () => {
    const path = `/tmp/openapi-shape-load-${Date.now()}.json`;
    await writeFile(
      path,
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
    );
    try {
      const doc = await loadDocument(path);
      expect(doc.components?.schemas?.X).toEqual({ type: ["string", "null"] });
      expect(doc.paths?.["/x"]?.get?.parameters?.[0]).toEqual({
        name: "limit",
        in: "query",
        schema: { type: "integer" },
      });
    } finally {
      await unlink(path);
    }
  });

  it("throws LoadError when file is missing", async () => {
    await expect(loadDocument("/tmp/does-not-exist-xyz.json")).rejects.toBeInstanceOf(LoadError);
  });

  it("throws LoadError on invalid JSON", async () => {
    const path = `/tmp/openapi-shape-bad-${Date.now()}.json`;
    await writeFile(path, "{ not json }");
    try {
      await expect(loadDocument(path)).rejects.toBeInstanceOf(LoadError);
    } finally {
      await unlink(path);
    }
  });

  it("accepts a file:// URL", async () => {
    const path = `/tmp/openapi-shape-fileurl-${Date.now()}.json`;
    await writeFile(path, JSON.stringify({ openapi: "3.1.0", info: { title: "U" } }));
    try {
      const url = new URL(`file://${path}`);
      const doc = await loadDocument(url);
      expect(doc.info?.title).toBe("U");
    } finally {
      await unlink(path);
    }
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

  it("throws BuildError on inline (non-$ref) branch", () => {
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
    ).toThrow(BuildError);
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
});
