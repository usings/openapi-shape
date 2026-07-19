import { describe, expect, it } from "vitest"
import { loadDocument, prepareDocument } from "../../../src/core/openapi/document"
import { LoadError } from "../../../src/core/openapi/errors"
import type { OpenAPISchemaObject } from "../../../src/core/openapi/types"
import { withTmpFile } from "../../_helpers/tmp"

function schemaObject(value: unknown): OpenAPISchemaObject {
  if (typeof value !== "object" || value === null) throw new Error("expected schema object")
  return value as OpenAPISchemaObject
}

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
        const doc = await loadDocument(path)
        expect(doc.components?.schemas?.X).toStrictEqual({
          anyOf: [{ type: "string" }, { type: "null" }],
        })
        expect(doc.paths?.["/x"]?.get?.parameters?.[0]).toStrictEqual({
          name: "limit",
          in: "query",
          schema: { type: "integer" },
        })
      },
    )
  })

  it("throws LoadError when file is missing", async () => {
    await expect(loadDocument("/tmp/does-not-exist-xyz.json")).rejects.toBeInstanceOf(LoadError)
  })

  it("throws LoadError on invalid JSON", async () => {
    await withTmpFile("{ not json }", async (path) => {
      await expect(loadDocument(path)).rejects.toBeInstanceOf(LoadError)
    })
  })

  it("parses .yaml sources as YAML", async () => {
    await withTmpFile(
      'openapi: "3.1.0"\ninfo:\n  title: Y\n',
      async (path) => {
        const doc = await loadDocument(path)
        expect(doc.info?.title).toBe("Y")
      },
      { ext: ".yaml" },
    )
  })

  it("parses .yml sources as YAML", async () => {
    await withTmpFile(
      'openapi: "3.1.0"\ninfo:\n  title: Y\n',
      async (path) => {
        const doc = await loadDocument(path)
        expect(doc.info?.title).toBe("Y")
      },
      { ext: ".yml" },
    )
  })

  it("keeps YAML date-like scalars as strings", async () => {
    await withTmpFile(
      "info:\n  title: 2020-01-01\n",
      async (path) => {
        const doc = await loadDocument(path)
        expect(doc.info?.title).toBe("2020-01-01")
      },
      { ext: ".yaml" },
    )
  })

  it("throws LoadError on invalid YAML", async () => {
    await withTmpFile(
      "a: [unclosed\n",
      async (path) => {
        await expect(loadDocument(path)).rejects.toBeInstanceOf(LoadError)
        await expect(loadDocument(path)).rejects.toThrow(/as YAML/)
      },
      { ext: ".yaml" },
    )
  })

  it("falls back to YAML when an unknown extension is not JSON", async () => {
    await withTmpFile(
      "info:\n  title: F\n",
      async (path) => {
        const doc = await loadDocument(path)
        expect(doc.info?.title).toBe("F")
      },
      { ext: ".txt" },
    )
  })

  it("accepts a file:// URL", async () => {
    await withTmpFile(JSON.stringify({ openapi: "3.1.0", info: { title: "U" } }), async (path) => {
      const doc = await loadDocument(new URL(`file://${path}`))
      expect(doc.info?.title).toBe("U")
    })
  })

  it("throws LoadError on unsupported URL protocol (e.g. ftp:)", async () => {
    await expect(loadDocument(new URL("ftp://example.com/openapi.json"))).rejects.toBeInstanceOf(
      LoadError,
    )
  })
})

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
    })
    expect(out.paths?.["/x"]?.get?.parameters?.[0]).toStrictEqual({
      name: "limit",
      in: "query",
      schema: { type: "integer" },
    })
  })

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
    })
    expect(out.paths?.["/x"]?.post?.requestBody).toStrictEqual({
      content: { "application/json": { schema: { type: "string" } } },
    })
  })

  it("resolves callback component refs", () => {
    const out = prepareDocument({
      components: {
        callbacks: {
          OnEvent: {
            "{$request.body#/callbackUrl}": {
              post: { responses: { "200": { description: "ok" } } },
            },
          },
        },
      },
      paths: {
        "/subscribe": {
          post: {
            callbacks: { onEvent: { $ref: "#/components/callbacks/OnEvent" } },
            responses: { "202": { description: "accepted" } },
          },
        },
      },
    })
    expect(out.paths?.["/subscribe"]?.post?.callbacks?.onEvent).toStrictEqual({
      "{$request.body#/callbackUrl}": {
        post: { responses: { "200": { description: "ok" } } },
      },
    })
  })

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
    ).toThrow(LoadError)
  })

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
    ).toThrow(LoadError)
  })
})

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
    })
    expect(schemaObject(out.components?.schemas?.Cat).properties?.type).toStrictEqual({
      const: "cat",
    })
    expect(schemaObject(out.components?.schemas?.Dog).properties?.type).toStrictEqual({
      const: "dog",
    })
  })

  it("makes an inline branch discriminator literal required", () => {
    const out = prepareDocument({
      components: {
        schemas: {
          Animal: {
            oneOf: [
              {
                type: "object",
                properties: { type: { const: "cat" }, purr: { type: "string" } },
              },
            ],
            discriminator: { propertyName: "type" },
          },
        },
      },
    })
    const animal = schemaObject(out.components?.schemas?.Animal)
    expect(schemaObject(animal.oneOf?.[0]).required).toStrictEqual(["type"])
  })

  it("accepts an inline branch when no discriminator literal can be inferred", () => {
    const input = {
      components: {
        schemas: {
          Animal: {
            oneOf: [{ type: "object", properties: { name: { type: "string" } } }],
            discriminator: { propertyName: "type" },
          },
        },
      },
    }
    expect(() => prepareDocument(input)).not.toThrow()
  })
})

describe("prepareDocument: idempotence", () => {
  it("running twice yields equal result", () => {
    const input = {
      components: {
        schemas: {
          X: { type: "string", nullable: true },
        },
      },
    }
    const once = prepareDocument(input)
    const twice = prepareDocument(once)
    expect(twice).toStrictEqual(once)
  })

  it("accepts in-memory doc with no openapi field", () => {
    expect(prepareDocument({})).toStrictEqual({})
    expect(prepareDocument({ info: { title: "T", version: "1" } })).toStrictEqual({
      info: { title: "T", version: "1" },
    })
  })

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
    })
    expect(
      out.webhooks?.event?.post?.requestBody?.content?.["application/json"]?.schema,
    ).toStrictEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })
})
