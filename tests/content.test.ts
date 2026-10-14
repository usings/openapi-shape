import { describe, expect, it } from "vitest"
import type { Version } from "./helpers/generate"
import { codes, entry, gen, genResult, oas, typeOf } from "./helpers/generate"
import { expectPassesTsc } from "./helpers/tsc"

/** The `response` member of `GET /r` for one 200 response's `content` map. */
async function responseType(
  content: Record<string, unknown>,
  version: Version = "3.1",
): Promise<string> {
  const code = await gen(
    oas(version, { paths: { "/r": { get: { responses: { "200": { content } } } } } }),
  )
  const match = /response: \{ "200": (.*) \}/.exec(entry(code, "GET /r"))
  if (!match) throw new Error(entry(code, "GET /r"))
  return match[1]
}

/** The `body` member of `POST /r` for a request `content` map. */
async function bodyOf(content: Record<string, unknown>, version: Version = "3.1"): Promise<string> {
  const code = await gen(
    oas(version, {
      paths: { "/r": { post: { requestBody: { required: true, content }, responses: {} } } },
    }),
  )
  const body = entry(code, "POST /r")
  return body.slice(body.indexOf("body: ") + 6, body.indexOf("\n  response:"))
}

// Content is typed as openapi-shape/client sends or returns it.

describe("media types without a schema", () => {
  it.each([
    [{ "application/json": {} }, "unknown"],
    [{ "application/problem+json": { schema: {} } }, "unknown"],
    [{ "*/*": {} }, "unknown"],
    [{ "text/plain": {} }, "string"],
    [{ "image/png": {} }, "Blob"],
    [{ "application/octet-stream": { schema: { description: "annotation only" } } }, "Blob"],
    [{ "application/xml": {} }, "Blob"],
  ])("%j → %s", async (content, expected) => {
    expect(await responseType(content)).toBe(expected)
  })
})

describe("media types with a schema", () => {
  it.each([
    // JSON, under any JSON media type or a wildcard that takes JSON, is typed by its schema…
    [
      { "text/json": { schema: { type: "object", properties: { id: { type: "integer" } } } } },
      "{ id?: number }",
    ],
    [{ "*/*": { schema: { type: "integer" } } }, "number"],
    // …text arrives as a string whatever its schema…
    [{ "text/csv": { schema: { type: "string" } } }, "string"],
    [{ "text/plain": { schema: { type: "integer" } } }, "string"],
    [{ "text/plain": { schema: { oneOf: [{ type: "integer" }, { type: "boolean" }] } } }, "string"],
    // A schema that says which strings keeps them.
    [{ "text/plain": { schema: { enum: ["ok", "no"] } } }, '"ok" | "no"'],
    // …and anything else as raw bytes.
    [
      {
        "application/xml": { schema: { type: "object", properties: { id: { type: "integer" } } } },
      },
      "Blob",
    ],
    [{ "application/vnd.github.diff": { schema: { type: "string" } } }, "Blob"],
    [{ "image/png": { schema: { type: "string", format: "binary" } } }, "Blob"],
    [{ "application/x-www-form-urlencoded": { schema: { type: "object" } } }, "Blob"],
    [{ "multipart/form-data": { schema: { type: "object" } } }, "Blob"],
  ])("%j → %s", async (content, expected) => {
    expect(await responseType(content)).toBe(expected)
  })

  it("types a wildcard response that may be raw bytes as text, too", async () => {
    const bytes = { type: "string", format: "binary" }
    const union = await responseType({
      "*/*": {
        schema: { oneOf: [bytes, { type: "object", properties: { message: { type: "string" } } }] },
      },
    })
    expect(union).toBe("Blob | { message?: string } | string")
  })

  it("reads a binary contentMediaType as raw bytes, saying so in 3.0, which lacks it", async () => {
    const image = { type: "string", contentMediaType: "image/png" }
    expect(await typeOf(image, "3.1")).toBe("Blob")
    const result = await genResult(
      oas("3.0", {
        paths: {
          "/pic": { get: { responses: { "200": { content: { "*/*": { schema: image } } } } } },
        },
      }),
    )
    expect(entry(result.code, "GET /pic")).toContain('"200": Blob | string')
    expect(codes(result.diagnostics)).toStrictEqual([
      "lenient-keyword #/paths/~1pic/get/responses/200/content/*~1*/schema/contentMediaType",
    ])
  })

  it("types raw bytes as a Blob, but as text under text/*, and as either from a wildcard", async () => {
    const bytes = { schema: { type: "string", format: "binary" } }
    const types = await Promise.all(
      (["3.0", "3.1"] as const).flatMap((version) => [
        responseType({ "application/json": bytes }, version),
        responseType({ "text/plain": bytes }, version),
        responseType({ "*/*": bytes }, version),
      ]),
    )
    expect(types).toStrictEqual([
      "Blob",
      "string",
      "Blob | string",
      "Blob",
      "string",
      "Blob | string",
    ])
  })

  it("types request bodies the client encodes by their schemas, and others as raw bytes", async () => {
    const object = { type: "object", properties: { a: { type: "integer" } } }
    expect(await bodyOf({ "application/x-www-form-urlencoded": { schema: object } })).toBe(
      '{ "application/x-www-form-urlencoded": { a?: number } }',
    )
    expect(await bodyOf({ "application/xml": { schema: object } })).toBe(
      '{ "application/xml": Blob }',
    )
  })
})

describe("streams and sequences", () => {
  it("types server-sent events as the client decodes them", async () => {
    const result = await genResult(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": { schema: { type: "object" } },
                    "text/event-stream": { schema: { $ref: "#/components/schemas/Chunk" } },
                  },
                },
              },
            },
          },
        },
        components: { schemas: { Chunk: { type: "object" } } },
      }),
    )
    expect(entry(result.code, "GET /r")).toContain(
      '"200": { [key: string]: unknown } | { data: string; event?: string; id?: string; retry?: number }[]',
    )
    expect(codes(result.diagnostics)).toStrictEqual([
      "ignored-keyword #/paths/~1r/get/responses/200/content/text~1event-stream/schema",
    ])
  })

  it("reads the schema of a JSON sequence as the type of each item", async () => {
    const result = await genResult(
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
    expect(entry(result.code, "POST /r")).toContain('"200": unknown[]')
    expect(codes(result.diagnostics)).toStrictEqual([
      "lenient-keyword #/paths/~1r/post/requestBody/content/application~1x-ndjson/schema",
    ])
  })
})

/** A `POST <path>` taking the `Upload` component as multipart/form-data. */
const upload = (path: string, encoding?: object) => ({
  [path]: {
    post: {
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": { schema: { $ref: "#/components/schemas/Upload" }, encoding },
        },
      },
      responses: {},
    },
  },
})

describe("multipart parts", () => {
  it("types 3.0 file parts by format", async () => {
    const body = await bodyOf(
      {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: {
              file: { type: "string", format: "binary" },
              files: { type: "array", items: { type: "string", format: "binary" } },
              meta: { type: "object", properties: { a: { type: "string" } } },
              note: { type: "string" },
            },
          },
        },
      },
      "3.0",
    )
    expect(body).toBe(
      '{\n    "multipart/form-data": {\n      /** @format binary */\n      file?: Blob\n      files?: Blob[]\n      meta?: { a?: string }\n      note?: string\n    }\n  }',
    )
  })

  it("types 3.1+ file parts by Encoding contentType, an untyped schema, or format: binary", async () => {
    const result = await genResult(
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
                        choice: { anyOf: [{ type: "string" }, { type: "integer" }] },
                      },
                    },
                    encoding: { avatar: { contentType: "image/png, image/jpeg" } },
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
        "      raw?: Blob",
        "      /** @contentMediaType image/png */",
        "      image?: Blob",
        "      avatar?: Blob",
        "      /** @contentEncoding base64 */",
        "      encoded?: string",
        "      /** @format binary */",
        "      legacy?: Blob",
        "      choice?: string | number",
      ].join("\n"),
    )
    expect(codes(result.diagnostics)).toStrictEqual([
      "lenient-format #/paths/~1r/post/requestBody/content/multipart~1form-data/schema/properties/legacy/format",
    ])
  })

  it("takes a Blob for file parts, also through named schemas and Encoding Objects", async () => {
    const code = await gen(
      oas("3.0", {
        // An Encoding Object can make a text part a file, too.
        paths: { ...upload("/r"), ...upload("/s", { note: { contentType: "image/png" } }) },
        components: {
          schemas: {
            Upload: {
              type: "object",
              required: ["file"],
              properties: { file: { type: "string", format: "binary" }, note: { type: "string" } },
            },
          },
        },
      }),
    )
    expect(entry(code, "POST /r")).toContain('body: { "multipart/form-data": Schemas.Upload }')
    await expectPassesTsc(
      code,
      [
        'import type { Endpoints } from "./file0"',
        'type Form<K extends keyof Endpoints> = Endpoints[K] extends { body: { "multipart/form-data": infer B } } ? B : never',
        'export const r: Form<"POST /r"> = { file: new Blob([]), note: "n" }',
        'export const s: Form<"POST /s"> = { file: new Blob([]), note: new Blob([]) }',
      ].join("\n"),
    )
  })

  it("types raw bytes as a Blob wherever a schema declares them", async () => {
    const bytes = { type: "string", format: "binary" }
    const result = await genResult(
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
                  "multipart/form-data": {
                    schema: { $ref: "#/components/schemas/Doc" },
                    encoding: { note: { contentType: "image/png" } },
                  },
                },
              },
              responses: {},
            },
          },
        },
        components: {
          schemas: {
            Doc: {
              type: "object",
              required: ["file"],
              properties: { file: bytes, note: { $ref: "#/components/schemas/Note" } },
            },
            Note: { type: "string" },
          },
        },
      }),
    )
    await expectPassesTsc(
      result.code,
      [
        'import type { Endpoints } from "./file0"',
        'type Body = Endpoints["POST /f"]["body"]',
        'export const parts: Body["multipart/form-data"] = { file: new Blob([]), note: new Blob([]) }',
        // An approximation: JSON, form fields, and parameters carry them as text.
        'export const json: Body["application/json"] = { file: new Blob([]) }',
        'export const query: Endpoints["POST /f"]["query"] = { q: new Blob([]) }',
        "// @ts-expect-error the note is text outside multipart",
        'export const form: Body["application/x-www-form-urlencoded"] = { file: new Blob([]), note: new Blob([]) }',
      ].join("\n"),
    )
  })

  it("makes a text part a file where the body's own schema declares it", async () => {
    const png = { note: { contentType: "image/png" } }
    const post = (schema: object) => ({
      post: {
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema, encoding: png } },
        },
        responses: {},
      },
    })
    const result = await genResult(
      oas("3.0", {
        paths: {
          "/composed": post({ $ref: "#/components/schemas/Composed" }),
          "/inline": post({
            allOf: [
              { $ref: "#/components/schemas/Base" },
              { type: "object", properties: { extra: { type: "string" } } },
            ],
          }),
          "/oneof": post({ $ref: "#/components/schemas/Alt" }),
          "/both": post({ $ref: "#/components/schemas/Both" }),
          "/twice": post({ $ref: "#/components/schemas/Twice" }),
          "/then": post({
            type: "object",
            properties: { note: { type: "string" } },
            if: { required: ["note"] },
            then: { $ref: "#/components/schemas/Base" },
            else: {},
          }),
          "/untyped-base": post({
            allOf: [
              { $ref: "#/components/schemas/Untyped" },
              { type: "object", properties: { note: { type: "string" } } },
            ],
          }),
        },
        components: {
          schemas: {
            Base: { type: "object", required: ["note"], properties: { note: { type: "string" } } },
            Composed: {
              allOf: [
                { $ref: "#/components/schemas/Base" },
                { type: "object", properties: { extra: { type: "string" } } },
              ],
            },
            Both: {
              allOf: [
                { $ref: "#/components/schemas/Base" },
                { type: "object", properties: { note: { type: "string", description: "Again" } } },
              ],
            },
            // Its own member, reached again through a reference.
            Twice: {
              allOf: [
                { type: "object", properties: { note: { type: "string" } } },
                { $ref: "#/components/schemas/TwiceNote" },
              ],
            },
            TwiceNote: { $ref: "#/components/schemas/Twice/allOf/0" },
            Untyped: { type: "object", properties: { note: {} } },
            Alt: {
              oneOf: [
                {
                  type: "object",
                  required: ["kind", "note"],
                  properties: { kind: { enum: ["a"] }, note: { type: ["string", "null"] } },
                },
                { type: "object", required: ["kind"], properties: { kind: { enum: ["b"] } } },
              ],
            },
          },
        },
      }),
    )
    // A referenced schema declares the part, too: it stays text.
    expect(codes(result.diagnostics)).toStrictEqual([
      "lenient-keyword #/components/schemas/Alt/oneOf/0/properties/note/type",
      "ignored-keyword #/paths/~1composed/post/requestBody/content/multipart~1form-data/encoding/note",
      "ignored-keyword #/paths/~1inline/post/requestBody/content/multipart~1form-data/encoding/note",
      "ignored-keyword #/paths/~1both/post/requestBody/content/multipart~1form-data/encoding/note",
      "ignored-keyword #/paths/~1twice/post/requestBody/content/multipart~1form-data/encoding/note",
      "ignored-keyword #/paths/~1then/post/requestBody/content/multipart~1form-data/encoding/note",
      "lenient-keyword #/paths/~1then/post/requestBody/content/multipart~1form-data/schema/if",
      "lenient-keyword #/paths/~1then/post/requestBody/content/multipart~1form-data/schema/then",
      "lenient-keyword #/paths/~1then/post/requestBody/content/multipart~1form-data/schema/else",
    ])
    await expectPassesTsc(
      result.code,
      [
        'import type { Endpoints } from "./file0"',
        'type Form<K extends keyof Endpoints> = Endpoints[K] extends { body: { "multipart/form-data": infer B } } ? B : never',
        'export const a: Form<"POST /composed"> = { note: "n" }',
        'export const b: Form<"POST /inline"> = { note: "n" }',
        'export const c: Form<"POST /oneof"> = { kind: "a", note: new Blob([]) }',
        'export const d: Form<"POST /both"> = { note: "n" }',
        'export const e: Form<"POST /twice"> = { note: "n" }',
        'export const g: Form<"POST /then"> = { note: "n" }',
        // A referenced schema that leaves the part untyped does not keep it text.
        'export const f: Form<"POST /untyped-base"> = { note: new Blob([]) }',
      ].join("\n"),
    )
  })

  it("keeps one-sided requiredness in a body whose text part becomes a file", async () => {
    const code = await gen(
      oas("3.0", {
        paths: {
          "/photos": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "multipart/form-data": {
                    schema: { $ref: "#/components/schemas/Photo" },
                    encoding: { image: { contentType: "image/png" } },
                  },
                },
              },
              responses: {},
            },
          },
        },
        components: {
          schemas: {
            Resource: { type: "object", properties: { id: { type: "string", readOnly: true } } },
            Photo: {
              allOf: [
                { $ref: "#/components/schemas/Resource" },
                {
                  type: "object",
                  required: ["id", "image"],
                  properties: { image: { type: "string" } },
                },
              ],
            },
          },
        },
      }),
    )
    await expectPassesTsc(
      code,
      [
        'import type { Endpoints } from "./file0"',
        'type Form = Endpoints["POST /photos"]["body"]["multipart/form-data"]',
        "// The readOnly id is not sent.",
        "export const photo: Form = { image: new Blob([]) }",
      ].join("\n"),
    )
  })

  it("takes a 3.0 part of a binary contentMediaType as a file, and says so", async () => {
    const result = await genResult(
      oas("3.0", {
        paths: {
          "/up": {
            post: {
              requestBody: {
                content: {
                  "multipart/form-data": {
                    schema: {
                      type: "object",
                      properties: { pic: { type: "string", contentMediaType: "image/png" } },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      }),
    )
    expect(entry(result.code, "POST /up")).toContain("pic?: Blob")
    expect(codes(result.diagnostics)).toStrictEqual([
      "lenient-keyword #/paths/~1up/post/requestBody/content/multipart~1form-data/schema/properties/pic/contentMediaType",
    ])
  })

  it("finds file parts in allOf members and in binary string media types", async () => {
    const result = await genResult(
      oas("3.1", {
        paths: {
          "/r": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "multipart/form-data": {
                    schema: {
                      allOf: [
                        { $ref: "#/components/schemas/Base" },
                        {
                          properties: {
                            doc: { type: "string", contentMediaType: "application/pdf" },
                          },
                        },
                      ],
                    },
                    encoding: { image: { contentType: "image/png" } },
                  },
                },
              },
              responses: {},
            },
          },
        },
        components: {
          schemas: {
            Base: { type: "object", properties: { image: {}, name: { type: "string" } } },
          },
        },
      }),
    )
    expect(entry(result.code, "POST /r")).toContain(
      [
        '"multipart/form-data": Schemas.Base & {',
        "      /** @contentMediaType application/pdf */",
        "      doc?: Blob",
        "      image?: Blob",
        "    }",
      ].join("\n"),
    )
    expect(codes(result.diagnostics)).toStrictEqual([
      "lenient-format #/paths/~1r/post/requestBody/content/multipart~1form-data/schema/allOf/1/properties/doc/contentMediaType",
    ])
  })
})

describe("3.2 itemSchema", () => {
  it("types the content as an array of items", async () => {
    const event = {
      type: "object",
      required: ["data"],
      properties: { data: { type: "string" }, event: { type: "string" } },
    }
    expect(await responseType({ "text/event-stream": { itemSchema: event } }, "3.2")).toBe(
      "{ data: string; event?: string }[]",
    )
    expect(
      await responseType({ "application/jsonl": { itemSchema: { type: "integer" } } }, "3.2"),
    ).toBe("number[]")
    // itemSchema is a 3.2 field, applied in earlier versions with a warning.
    const result = await genResult(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              responses: {
                "200": { content: { "application/jsonl": { itemSchema: { type: "integer" } } } },
              },
            },
          },
        },
      }),
    )
    expect(entry(result.code, "GET /r")).toContain('"200": number[]')
    expect(codes(result.diagnostics)).toStrictEqual([
      "lenient-keyword #/paths/~1r/get/responses/200/content/application~1jsonl/itemSchema",
    ])
  })
})
