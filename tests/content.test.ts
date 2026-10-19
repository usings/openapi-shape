import { describe, expect, it } from "vitest"
import { generate } from "../src/index"
import type { Version } from "./helpers/generate"
import { codes, entry, gen, oas } from "./helpers/generate"
import { expectPassesTsc } from "./helpers/tsc"

/** The type of one media type's content in a 200 response of `GET /r`. */
async function contentType(
  mediaType: string,
  media: object,
  version: Version = "3.1",
): Promise<string> {
  const content = { [mediaType]: media }
  const code = await gen(
    oas(version, { paths: { "/r": { get: { responses: { "200": { content } } } } } }),
  )
  const text = entry(code, "GET /r")
  const prefix = `"200": { content: { ${JSON.stringify(mediaType)}: `
  const at = text.indexOf(prefix)
  if (at === -1) throw new Error(text)
  // The type ends where the content map closes: at the first unmatched `}`.
  const rest = text.slice(at + prefix.length)
  let depth = 0
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "{") depth++
    else if (rest[i] === "}" && depth-- === 0) return rest.slice(0, i).trim()
  }
  throw new Error(text)
}

// Content is typed by what its media type carries: JSON, form, and multipart
// content by its schema, text as a string, anything else as raw bytes.

describe("media types without a schema", () => {
  it.each([
    ["application/json", {}, "unknown"],
    ["application/problem+json", { schema: {} }, "unknown"],
    ["*/*", {}, "unknown"],
    ["text/plain", {}, "string"],
    // A `text/*` response may be JSON, such as `text/json`.
    ["text/*", {}, "unknown"],
    ["image/png", {}, "Blob"],
    ["application/octet-stream", { schema: { description: "annotation only" } }, "Blob"],
    ["application/xml", {}, "Blob"],
  ])("%s %j → %s", async (mediaType, media, expected) => {
    expect(await contentType(mediaType, media)).toBe(expected)
  })
})

describe("media types with a schema", () => {
  const object = { type: "object", properties: { id: { type: "integer" } } }
  it.each([
    // JSON, under any JSON media type or a wildcard that takes JSON, is typed by its schema…
    ["text/json", object, "{ id?: number }"],
    ["*/*", { type: "integer" }, "number"],
    // …and so are form and multipart content…
    ["application/x-www-form-urlencoded", object, "{ id?: number }"],
    ["multipart/form-data", object, "{ id?: number }"],
    // …text is a string whatever its schema, unless it says which strings…
    ["text/csv", { type: "string" }, "string"],
    ["text/plain", { type: "integer" }, "string"],
    ["text/plain", { oneOf: [{ type: "integer" }, { type: "boolean" }] }, "string"],
    ["text/plain", { enum: ["ok", "no"] }, '"ok" | "no"'],
    ["text/event-stream", { type: "string" }, "string"],
    // …under `text/*` too, whose JSON the schema types: unknown, where it does not say strings…
    ["text/*", { enum: ["ok", "no"] }, '"ok" | "no"'],
    ["text/*", object, "unknown"],
    // …and anything else is raw bytes.
    ["application/xml", object, "Blob"],
    ["application/vnd.github.diff", { type: "string" }, "Blob"],
    ["image/png", { type: "string", format: "binary" }, "Blob"],
  ])("%s %j → %s", async (mediaType, schema, expected) => {
    expect(await contentType(mediaType, { schema })).toBe(expected)
  })

  it("types raw bytes as Blob, string, or unknown according to the media type", async () => {
    const bytes = { schema: { type: "string", format: "binary" } }
    const types = await Promise.all(
      (["3.0", "3.1"] as const).flatMap((version) => [
        contentType("application/json", bytes, version),
        contentType("text/plain", bytes, version),
        contentType("text/*", bytes, version),
        contentType("*/*", bytes, version),
      ]),
    )
    expect(types).toStrictEqual([
      "Blob",
      "string",
      "unknown",
      "Blob",
      "Blob",
      "string",
      "unknown",
      "Blob",
    ])
  })

  it("reads a binary contentMediaType as raw bytes, also in 3.0, which lacks it", async () => {
    const image = { schema: { type: "string", contentMediaType: "image/png" } }
    expect(await contentType("*/*", image, "3.1")).toBe("Blob")
    const result = await generate(
      oas("3.0", {
        paths: { "/pic": { get: { responses: { "200": { content: { "*/*": image } } } } } },
      }),
    )
    expect(entry(result.code, "GET /pic")).toContain('"200": { content: { "*/*": Blob } }')
    expect(result.diagnostics).toStrictEqual([])
  })
})

describe("streams and sequences", () => {
  it("types itemSchema content as an array of items", async () => {
    const event = {
      type: "object",
      required: ["data"],
      properties: { data: { type: "string" }, event: { type: "string" } },
    }
    expect(await contentType("text/event-stream", { itemSchema: event }, "3.2")).toBe(
      "{ data: string; event?: string }[]",
    )
    expect(await contentType("application/jsonl", { itemSchema: { type: "integer" } }, "3.2")).toBe(
      "number[]",
    )
    // itemSchema is a 3.2 field, applied in earlier versions too; it
    // applies to sequential media types only.
    const result = await generate(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/jsonl": { itemSchema: { type: "integer" } },
                    "application/json": { itemSchema: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      }),
    )
    expect(entry(result.code, "GET /r")).toContain(
      '"200": { content: { "application/jsonl": number[]; "application/json": unknown } }',
    )
    expect(codes(result.diagnostics)).toStrictEqual([
      "ignored-field #/paths/~1r/get/responses/200/content/application~1json/itemSchema",
    ])
  })

  it("reads the schema of a JSON sequence as the type of each item", async () => {
    const result = await generate(
      oas("3.1", {
        paths: {
          "/r": {
            post: {
              requestBody: {
                required: true,
                content: { "application/x-ndjson": { schema: { type: "integer" } } },
              },
              responses: { "200": { content: { "application/jsonl": {} } } },
            },
          },
        },
      }),
    )
    expect(entry(result.code, "POST /r")).toContain('body: { "application/x-ndjson": number[] }')
    expect(entry(result.code, "POST /r")).toContain(
      '"200": { content: { "application/jsonl": unknown[] } }',
    )
    expect(result.diagnostics).toStrictEqual([])
  })
})

describe("multipart parts", () => {
  it("types parts by their schemas, raw bytes as Blobs, whatever the Encoding Objects say", async () => {
    const result = await generate(
      oas("3.1", {
        paths: {
          "/r": {
            post: {
              requestBody: {
                content: {
                  "multipart/form-data": {
                    schema: {
                      type: "object",
                      properties: {
                        raw: {},
                        image: { contentMediaType: "image/png" },
                        avatar: { type: "string" },
                        encoded: { type: "string", contentEncoding: "base64" },
                        legacy: { type: "string", format: "binary" },
                        files: { type: "array", items: { type: "string", format: "binary" } },
                      },
                    },
                    encoding: { avatar: { contentType: "image/png" } },
                  },
                },
              },
              responses: {},
            },
          },
        },
      }),
    )
    expect(entry(result.code, "POST /r")).toContain(
      [
        '"multipart/form-data": {',
        "      raw?: unknown",
        "      /** @contentMediaType image/png */",
        "      image?: unknown",
        "      avatar?: string",
        "      /** @contentEncoding base64 */",
        "      encoded?: string",
        "      /** @format binary */",
        "      legacy?: Blob",
        "      files?: Blob[]",
      ].join("\n"),
    )
    expect(result.diagnostics).toStrictEqual([])
  })

  it("types raw bytes as a Blob wherever a schema declares them", async () => {
    const bytes = { type: "string", format: "binary" }
    const result = await generate(
      oas("3.1", {
        paths: {
          "/f": {
            post: {
              parameters: [{ name: "q", in: "query", schema: bytes }],
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Doc" } },
                  "application/x-www-form-urlencoded": {
                    schema: { $ref: "#/components/schemas/Doc" },
                  },
                  "multipart/form-data": { schema: { $ref: "#/components/schemas/Doc" } },
                },
              },
              responses: {},
            },
          },
        },
        components: {
          schemas: {
            Doc: { type: "object", required: ["file"], properties: { file: bytes } },
          },
        },
      }),
    )
    await expectPassesTsc(
      result.code,
      [
        'import type { Endpoints } from "./file0"',
        'type Body = Endpoints["POST /f"]["body"]',
        'export const parts: Body["multipart/form-data"] = { file: new Blob([]) }',
        // The types preserve file declarations; the client rejects Blob values in these text locations.
        'export const json: Body["application/json"] = { file: new Blob([]) }',
        'export const form: Body["application/x-www-form-urlencoded"] = { file: new Blob([]) }',
        'export const query: Endpoints["POST /f"]["query"] = { q: new Blob([]) }',
      ].join("\n"),
    )
  })
})
