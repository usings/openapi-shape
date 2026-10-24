import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { Encoding, EndpointContract } from "../src/client/contract"
import { generate } from "../src/core/index"
import { contractOf } from "./helpers/contract"
import { codes, entry, gen, oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"
import { expectPassesTsc, typecheck } from "./helpers/tsc"

const ok = { "200": { description: "OK" } }
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })

describe("methods", () => {
  it("emits fetch-supported fixed methods, uppercase, in Path Item order", async () => {
    const methods = ["trace", "patch", "head", "options", "delete", "post", "put", "get"]
    const code = await gen(
      oas("3.1", {
        paths: { "/r": Object.fromEntries(methods.map((m) => [m, { responses: ok }])) },
      }),
    )
    const { endpoints } = await contractOf(code)
    expect(Object.keys(endpoints)).toStrictEqual([
      "GET /r",
      "PUT /r",
      "POST /r",
      "DELETE /r",
      "OPTIONS /r",
      "HEAD /r",
      "PATCH /r",
    ])
    expect(code).not.toContain('"TRACE /r"')
  })

  it("supports QUERY and additionalOperations in 3.2", async () => {
    const result = await generate(
      oas("3.2", {
        paths: {
          "/r": {
            query: { requestBody: json({ type: "string" }), responses: ok },
            additionalOperations: { COPY: { responses: ok }, POST: { responses: ok } },
          },
        },
      }),
    )
    expect(result.code).toContain('"QUERY /r": {')
    expect(result.code).toContain('"COPY /r": {')
    expect(result.code).not.toContain('"POST /r"')
    expect(codes(result.diagnostics)).toStrictEqual([
      "ignored-field #/paths/~1r/additionalOperations/POST",
    ])
  })

  it("applies 3.2 fields in earlier versions too", async () => {
    const result = await generate(
      oas("3.1", {
        paths: {
          "/r": { query: { responses: ok }, additionalOperations: { COPY: { responses: ok } } },
        },
      }),
    )
    expect(result.code).toContain('"QUERY /r"')
    expect(result.code).toContain('"COPY /r"')
    expect(result.diagnostics).toStrictEqual([])
  })

  it("documents operations", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              operationId: "getR",
              summary: "Get R",
              description: "Longer text.",
              deprecated: true,
              externalDocs: { url: "https://example.com/r" },
              responses: ok,
            },
          },
        },
      }),
    )
    expect(code).toContain(
      '  /**\n   * Get R\n   *\n   * Longer text.\n   *\n   * @deprecated\n   * @operationId getR\n   * @see https://example.com/r\n   */\n  "GET /r": {',
    )
  })
})

describe("parameters", () => {
  it("groups parameters by location, typed by their schemas", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/users/{id}": {
            get: {
              parameters: [
                { name: "id", in: "path", required: true, schema: { type: "integer" } },
                { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
                { name: "limit", in: "query", required: true, schema: { type: "integer" } },
                { name: "X-Trace", in: "header", schema: { type: "string", format: "uuid" } },
                { name: "session", in: "cookie", required: true, schema: { type: "string" } },
              ],
              responses: ok,
            },
          },
        },
      }),
    )
    const operation = entry(code, "GET /users/{id}")
    expect(operation).toContain("params: { id: number }")
    expect(operation).toContain("query: { tags?: string[]; limit: number }")
    expect(operation).toContain('"X-Trace"?: string')
    expect(operation).toContain("/** @format uuid */")
    expect(operation).toContain("headers: {")
    expect(operation).toContain("cookies: { session: string }")
  })

  it("lets operation parameters override path parameters by name and location", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/r": {
            parameters: [
              { name: "q", in: "query", schema: { type: "string" } },
              { name: "x-id", in: "header", schema: { type: "string" } },
              { name: "keep", in: "query", schema: { type: "boolean" } },
            ],
            get: {
              parameters: [
                { name: "q", in: "query", required: true, schema: { type: "integer" } },
                // Header names are case-insensitive.
                { name: "X-ID", in: "header", schema: { type: "integer" } },
              ],
              responses: ok,
            },
          },
        },
      }),
    )
    expect(entry(code, "GET /r")).toContain("query: { q: number; keep?: boolean }")
    expect(entry(code, "GET /r")).toContain('"X-ID"?: number')
    expect(entry(code, "GET /r")).not.toContain('"x-id"')
  })

  it("ignores Accept, Content-Type, and Authorization header parameters, as the spec requires", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              parameters: ["accept", "Content-Type", "AUTHORIZATION"].map((name) => ({
                name,
                in: "header",
                schema: { type: "string" },
              })),
              responses: ok,
            },
          },
        },
      }),
    )
    const operation = entry(code, "GET /r")
    expect(operation).not.toContain("headers")
    for (const name of ["accept", "Content-Type", "AUTHORIZATION"])
      expect(operation).not.toContain(name)
  })

  it("types parameters declared with content", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              parameters: [
                {
                  name: "filter",
                  in: "query",
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { a: { type: "string" } } },
                    },
                  },
                },
              ],
              responses: ok,
            },
          },
        },
      }),
    )
    expect(entry(code, "GET /r")).toContain("query?: { filter?: { a?: string } }")
  })

  it("matches path parameters to the path template", async () => {
    const result = await generate(
      oas("3.1", {
        paths: {
          "/a/{x}/b/{y}": {
            get: {
              parameters: [
                { name: "stray", in: "path", required: true, schema: { type: "string" } },
                { name: "y", in: "path", required: true, schema: { type: "integer" } },
              ],
              responses: ok,
            },
          },
        },
      }),
    )
    expect(entry(result.code, "GET /a/{x}/b/{y}")).toContain("params: { x: string; y: number }")
    expect(codes(result.diagnostics)).toStrictEqual([
      "path-parameter-mismatch #/paths/~1a~1{x}~1b~1{y}/get",
      "path-parameter-mismatch #/paths/~1a~1{x}~1b~1{y}/get",
    ])
  })

  it("reports invalid parameters", async () => {
    const result = await generate(
      oas("3.1", {
        paths: {
          "/r/{id}": {
            get: {
              parameters: [
                { name: "id", in: "path", schema: { type: "string" } },
                { name: "where", in: "body", schema: {} },
                { in: "query" },
                {
                  name: "both",
                  in: "query",
                  schema: { type: "string" },
                  content: { "text/plain": {} },
                },
                { name: "neither", in: "query" },
                {
                  name: "qs",
                  in: "querystring",
                  content: { "application/x-www-form-urlencoded": {} },
                },
              ],
              responses: ok,
            },
          },
        },
      }),
    )
    // The 3.2 querystring parameter is applied too, replacing the query parameters.
    expect(entry(result.code, "GET /r/{id}")).toContain("query?: unknown")
    expect(codes(result.diagnostics)).toStrictEqual([
      "invalid-parameter #/paths/~1r~1{id}/get/parameters/1/in",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters/2",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters/0",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters/3",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters/4",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters",
    ])
  })

  it("types a 3.2 querystring parameter as the whole query", async () => {
    const result = await generate(
      oas("3.2", {
        paths: {
          "/search": {
            get: {
              parameters: [
                {
                  name: "ignored",
                  in: "querystring",
                  required: true,
                  content: {
                    "application/x-www-form-urlencoded": {
                      schema: {
                        type: "object",
                        properties: { q: { type: "string" } },
                        required: ["q"],
                      },
                    },
                  },
                },
                { name: "page", in: "query", schema: { type: "integer" } },
              ],
              responses: ok,
            },
          },
        },
      }),
    )
    expect(entry(result.code, "GET /search")).toContain("query: { q: string }")
    expect(codes(result.diagnostics)).toStrictEqual([
      "invalid-parameter #/paths/~1search/get/parameters",
    ])
  })
})

describe("request bodies", () => {
  it("maps media types to types, required or optional", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/a": {
            post: { requestBody: { required: true, ...json({ type: "string" }) }, responses: ok },
          },
          "/b": {
            put: {
              requestBody: {
                description: "Either form",
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { n: { type: "integer" } } },
                  },
                  "text/plain": {},
                },
              },
              responses: ok,
            },
          },
        },
      }),
    )
    expect(entry(code, "POST /a")).toContain('body: { "application/json": string }')
    const optional = entry(code, "PUT /b")
    expect(optional).toContain(
      'body?: { "application/json": { n?: number }; "text/plain": string }',
    )
  })

  it("keeps DELETE request bodies in 3.0 and 3.1", async () => {
    const paths = { "/r": { delete: { requestBody: json({ type: "string" }), responses: ok } } }
    const result30 = await generate(oas("3.0", { paths }))
    expect(entry(result30.code, "DELETE /r")).toContain('body?: { "application/json": string }')
    expect(result30.diagnostics).toStrictEqual([])
    const result31 = await generate(oas("3.1", { paths }))
    expect(entry(result31.code, "DELETE /r")).toContain("body?:")
    expect(result31.diagnostics).toStrictEqual([])
  })
})

describe("responses", () => {
  it("keeps status keys and media types, and leaves out content that is not declared", async () => {
    const result = await generate(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              responses: {
                "200": {
                  description: "Pet",
                  content: { "application/json": { schema: { type: "object" } }, "text/csv": {} },
                },
                "204": { description: "Nothing" },
                "4xx": { description: "Client error", ...json({ type: "string" }) },
                "default": { description: "Other", content: {} },
                "x-internal": { description: "extension" },
              },
            },
          },
        },
      }),
    )
    const operation = entry(result.code, "GET /r")
    expect(operation).toContain(
      '"200": { content: { "application/json": { [key: string]: unknown }; "text/csv": string } }',
    )
    expect(operation).toContain('"204": {}')
    expect(operation).toContain('"4XX": { content: { "application/json": string } }')
    expect(operation).toContain('"default": {}')
    expect(operation).not.toContain("x-internal")
    // A lowercase range means the same range.
    expect(result.diagnostics).toStrictEqual([])
  })

  it("merges status keys that differ only in case", async () => {
    const result = await generate(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              responses: {
                "2xx": { description: "a", ...json({ type: "string" }) },
                "2XX": {
                  description: "b",
                  content: {
                    "application/json": { schema: { type: "number" } },
                    "text/plain": {},
                  },
                },
              },
            },
          },
        },
      }),
    )
    expect(entry(result.code, "GET /r")).toContain(
      '"2XX": { content: { "application/json": string | number; "text/plain": string } }',
    )
    await expectPassesTsc(result.code)
  })

  it("types response headers, ignoring Content-Type", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              responses: {
                "200": {
                  description: "OK",
                  headers: {
                    "X-Rate-Limit": { required: true, schema: { type: "integer" } },
                    "Content-Type": { schema: { type: "string" } },
                    "Link": { description: "Pagination", schema: { type: "string" } },
                  },
                },
                "404": { description: "Missing" },
              },
            },
          },
        },
      }),
    )
    const operation = entry(code, "GET /r")
    expect(operation).toContain('"X-Rate-Limit": number')
    expect(operation).toContain("/** Pagination */")
    expect(operation).toContain("Link?: string")
    expect(operation).not.toContain('"Content-Type"')
  })

  it("leaves the response map empty when no responses are declared", async () => {
    const operation = entry(await gen(oas("3.1", { paths: { "/r": { get: {} } } })), "GET /r")
    expect(operation).toBe("{\n  responses: {}\n}")
  })
})

describe("webhooks and callbacks", () => {
  it("emits webhooks, also in 3.0, which lacks them", async () => {
    const webhooks = {
      "pet.created": { post: { requestBody: json({ type: "string" }), responses: ok } },
    }
    const code = await gen(oas("3.1", { webhooks }))
    expect(code).toContain(
      'export interface Webhooks {\n  "POST pet.created": {\n    body?: { "application/json": string }',
    )
    const result30 = await generate(oas("3.0", { webhooks }))
    expect(result30.code).toContain('"POST pet.created"')
    expect(result30.diagnostics).toStrictEqual([])
  })

  it("types form and multipart content by its schema in both directions", async () => {
    const form = { type: "object", properties: { count: { type: "integer" } } }
    const incoming = {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: form },
            "application/x-www-form-urlencoded": { schema: form },
          },
        },
        responses: {
          "200": { description: "OK", content: { "multipart/form-data": { schema: form } } },
        },
      },
    }
    const code = await gen(
      oas("3.1", {
        paths: {
          "/subscribe": {
            post: { responses: ok, callbacks: { onEvent: { "{$request.body#/url}": incoming } } },
          },
        },
        webhooks: { "pet.created": incoming },
      }),
    )
    // Your handler reads the request and writes the response, as their schemas say.
    const expected = [
      'body: { "application/json": { count?: number }; "application/x-www-form-urlencoded": { count?: number } }',
      'responses: {\n    /** OK */\n    "200": { content: { "multipart/form-data": { count?: number } } }\n  }',
    ]
    for (const key of [
      "POST pet.created",
      "POST /subscribe > onEvent > POST {$request.body#/url}",
    ]) {
      for (const member of expected) expect(entry(code, key)).toContain(member)
    }
  })

  it("flattens nested and referenced callbacks with chained keys", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/subscribe": {
            post: {
              responses: ok,
              callbacks: { onEvent: { $ref: "#/components/callbacks/Event" } },
            },
          },
        },
        components: {
          callbacks: {
            Event: {
              "{$request.body#/url}/{id}": {
                parameters: [
                  { name: "id", in: "path", required: true, schema: { type: "string" } },
                ],
                post: {
                  requestBody: json({ type: "string" }),
                  responses: ok,
                  callbacks: { again: { $ref: "#/components/callbacks/Event" } },
                },
              },
            },
          },
        },
      }),
    )
    expect(code).toContain(
      '  "POST /subscribe > onEvent > POST {$request.body#/url}/{id}": {\n    params: { id: string }',
    )
    // The nested reference to the same callback stops the chain instead of recursing forever.
    expect(code).not.toContain("> again >")
    await expectPassesTsc(code)
  })
})

describe("path items", () => {
  it("merges every link of a Path Item reference chain, nearest fields first", async () => {
    const result = await generate(
      oas("3.1", {
        paths: { "/r": { $ref: "#/components/pathItems/Middle" } },
        components: {
          pathItems: {
            Middle: {
              $ref: "#/components/pathItems/Leaf",
              get: { responses: { "201": { description: "middle" } } },
              delete: { responses: ok },
              parameters: [{ in: "query", name: "middle", schema: { type: "string" } }],
            },
            Leaf: { get: { responses: ok }, post: { responses: ok } },
          },
        },
      }),
    )
    expect(entry(result.code, "GET /r")).toContain('"201": {}')
    expect(entry(result.code, "GET /r")).not.toContain('"200": {}')
    expect(entry(result.code, "POST /r")).toContain("middle?: string")
    expect(result.code).toContain('"DELETE /r"')
    expect(codes(result.diagnostics)).toStrictEqual([
      "path-item-conflict #/components/pathItems/Middle/get",
    ])
  })

  it("keeps intermediate Path Item fields relative to their own document", async () => {
    await withFiles(
      {
        "entry.json": oas("3.1", {
          paths: {
            "/a": { $ref: "paths/middle.json" },
            "/b": { $ref: "paths/middle.json" },
          },
        }),
        "paths/middle.json": {
          $ref: "leaf.json",
          get: { responses: { "200": json({ $ref: "../model.json" }) } },
        },
        "paths/leaf.json": { post: { responses: ok } },
        "model.json": { type: "string" },
      },
      async (dir) => {
        const result = await generate(join(dir, "entry.json"))
        expect(entry(result.code, "GET /a")).toContain('"application/json": Schemas.model')
        expect(entry(result.code, "GET /b")).toContain('"application/json": Schemas.model')
        expect(result.code).toContain("export type model = string")
        expect(result.code).toContain('"POST /a"')
        expect(result.code).toContain('"POST /b"')
        expect(result.diagnostics).toStrictEqual([])
      },
    )
  })

  it("rejects a Path Item reference cycle even when its links have local operations", async () => {
    await expect(
      generate(
        oas("3.1", {
          paths: { "/r": { $ref: "#/components/pathItems/A" } },
          components: {
            pathItems: {
              A: { $ref: "#/components/pathItems/B", get: { responses: ok } },
              B: { $ref: "#/components/pathItems/A", post: { responses: ok } },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ diagnostics: [expect.objectContaining({ code: "circular-ref" })] })
  })

  it("skips specification extensions in the Paths Object", async () => {
    const code = await gen(
      oas("3.1", {
        paths: { "x-internal": { get: { responses: ok } }, "/r": { get: { responses: ok } } },
      }),
    )
    expect(code).not.toContain("x-internal")
    expect(code).toContain('"GET /r"')
  })

  it("merges a referenced Path Item with local fields, reporting conflicts", async () => {
    const result = await generate(
      oas("3.1", {
        paths: {
          "/r": {
            $ref: "#/components/pathItems/R",
            get: { responses: { "201": { description: "local" } } },
          },
        },
        components: {
          pathItems: { R: { get: { responses: ok }, put: { responses: ok } } },
        },
      }),
    )
    expect(entry(result.code, "GET /r")).toContain('"201": {}')
    expect(result.code).toContain('"PUT /r"')
    expect(codes(result.diagnostics)).toStrictEqual(["path-item-conflict #/paths/~1r/get"])
  })
})

/** The fields of the contract format, as the client's types define them, every one listed. */
const ENTRY_FIELDS = [
  "stream",
  "params",
  "query",
  "querystring",
  "headers",
  "contentType",
  "bodyEncodings",
] as const satisfies ReadonlyArray<keyof EndpointContract>
const ENCODING_FIELDS = [
  "style",
  "explode",
  "allowReserved",
  "contentType",
  "repeat",
] as const satisfies ReadonlyArray<keyof Encoding>
type Lists<T, L extends readonly unknown[]> = [Exclude<keyof T, L[number]>] extends [never]
  ? true
  : false
expectTypeOf<Lists<EndpointContract, typeof ENTRY_FIELDS>>().toEqualTypeOf<true>()
expectTypeOf<Lists<Encoding, typeof ENCODING_FIELDS>>().toEqualTypeOf<true>()

/** Fields of a contract the client does not read. */
function unknownFields(contract: object): string[] {
  const out = Object.keys(contract).filter((key) => key !== "version" && key !== "endpoints")
  const { endpoints } = contract as { endpoints: Record<string, Record<string, unknown>> }
  for (const [endpoint, fields] of Object.entries(endpoints)) {
    for (const [field, value] of Object.entries(fields)) {
      if (!(ENTRY_FIELDS as readonly string[]).includes(field)) out.push(`${endpoint} ${field}`)
      if (field === "stream" || typeof value !== "object" || value === null) continue
      const maps = field === "bodyEncodings" ? Object.values(value) : [value]
      for (const [name, encoding] of maps.flatMap((map) =>
        Object.entries(map as Record<string, object>),
      )) {
        for (const key of Object.keys(encoding)) {
          if (!(ENCODING_FIELDS as readonly string[]).includes(key)) {
            out.push(`${endpoint} ${field}.${name}.${key}`)
          }
        }
      }
    }
  }
  return out
}

describe("runtime contract", () => {
  it("has only fields the client reads, in every fixture", async () => {
    const fixtures = join(import.meta.dirname, "fixtures")
    const documents = [
      join(fixtures, "client.yaml"),
      join(fixtures, "readme.yaml"),
      ...["v3.0", "v3.1", "v3.2"].flatMap((version) =>
        readdirSync(join(fixtures, "oai", version)).map((file) =>
          join(fixtures, "oai", version, file),
        ),
      ),
    ]
    const querystring = oas("3.2", {
      paths: {
        "/q": {
          get: {
            parameters: [
              { name: "q", in: "querystring", content: { "application/json": { schema: {} } } },
            ],
            responses: ok,
          },
        },
      },
    })
    const profiled = oas("3.1", {
      paths: {
        "/p": {
          post: {
            requestBody: { content: { 'application/json; profile="p"': { schema: {} } } },
            responses: ok,
          },
        },
      },
    })
    const contracts = await Promise.all(
      [...documents, querystring, profiled].map(async (document) => {
        const { code } = await generate(document)
        return contractOf(code)
      }),
    )
    expect(contracts.flatMap((contract) => unknownFields(contract))).toStrictEqual([])
    // The fixtures reach every field the client reads.
    const written = new Set(
      contracts.flatMap((contract) =>
        Object.values(contract.endpoints).flatMap((e) => Object.keys(e ?? {})),
      ),
    )
    expect([...written].toSorted()).toStrictEqual([...ENTRY_FIELDS].toSorted())
  })

  it("records each endpoint's serialization where it differs from OpenAPI's defaults", async () => {
    const result = await generate(
      oas("3.1", {
        servers: [{ url: "https://api.test/v1" }],
        paths: {
          "/items/{id}": {
            servers: [{ url: "https://files.api.test" }],
            get: {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  style: "label",
                  schema: { type: "array" },
                },
                { name: "plain", in: "query", schema: { type: "string" } },
                {
                  name: "explicitDefault",
                  in: "query",
                  style: "form",
                  explode: true,
                  schema: { type: "array" },
                },
                {
                  name: "created",
                  in: "query",
                  style: "deepObject",
                  explode: true,
                  schema: { type: "object" },
                },
                { name: "ids", in: "query", style: "pipeDelimited", schema: { type: "array" } },
                { name: "tags", in: "query", explode: false, schema: { type: "array" } },
                { name: "next", in: "query", allowReserved: true, schema: { type: "string" } },
                {
                  name: "filter",
                  in: "query",
                  content: { "application/json": { schema: { type: "object" } } },
                },
                { name: "X-Range", in: "header", explode: true, schema: { type: "object" } },
                { name: "session", in: "cookie", explode: false, schema: { type: "array" } },
              ],
              responses: ok,
            },
            put: {
              requestBody: {
                content: {
                  "application/x-www-form-urlencoded": {
                    schema: { type: "object" },
                    encoding: {
                      metadata: { style: "deepObject", explode: true },
                      plain: { contentType: "text/plain" },
                      styled: { style: "form", explode: false, contentType: "application/json" },
                    },
                  },
                },
              },
              responses: ok,
            },
            post: {
              requestBody: {
                content: {
                  "multipart/form-data": {
                    schema: { type: "object" },
                    encoding: { meta: { contentType: "application/json" } },
                  },
                  "application/octet-stream": {},
                },
              },
              responses: ok,
            },
            patch: { requestBody: { content: { "application/json": {} } }, responses: ok },
          },
        },
      }),
    )
    const { endpoints } = await contractOf(result.code)
    expect(endpoints).toStrictEqual({
      "GET /items/{id}": {
        params: { id: { style: "label", explode: false } },
        query: {
          created: { style: "deepObject", explode: true },
          ids: { style: "pipeDelimited", explode: false },
          tags: { style: "form", explode: false },
          next: { style: "form", explode: true, allowReserved: true },
          filter: { contentType: "application/json" },
        },
        headers: { "X-Range": { style: "simple", explode: true } },
      },
      "PUT /items/{id}": {
        contentType: "application/x-www-form-urlencoded",
        bodyEncodings: {
          "application/x-www-form-urlencoded": {
            metadata: { style: "deepObject", explode: true },
            plain: { contentType: "text/plain", repeat: true },
            styled: { style: "form", explode: false },
          },
        },
      },
      // Two media types and neither takes JSON: the call names one.
      "POST /items/{id}": {
        bodyEncodings: { "multipart/form-data": { meta: { contentType: "application/json" } } },
      },
      "PATCH /items/{id}": {
        contentType: "application/json",
      },
    })
    // The client sends every request to its baseUrl; the document's servers are documentation.
    expect(result.code).toContain("// Server: https://api.test/v1\n")
    expect(codes(result.diagnostics).filter((c) => c.startsWith("ignored"))).toStrictEqual([
      "ignored-field #/paths/~1items~1{id}/servers",
    ])
    await expectPassesTsc(result.code)
  })

  it("describes GET and HEAD bodies without emitting their unused runtime encodings", async () => {
    const form = {
      content: {
        "application/x-www-form-urlencoded": {
          schema: { type: "object", properties: { a: { type: "object" } } },
          encoding: { a: { style: "deepObject", explode: true } },
        },
      },
    }
    const operation = { requestBody: form, responses: ok }
    const code = await gen(
      oas("3.1", { paths: { "/r": { get: operation, head: operation, post: operation } } }),
    )
    const { endpoints } = await contractOf(code)
    expect(endpoints).toStrictEqual({
      "GET /r": {},
      "HEAD /r": {},
      "POST /r": {
        contentType: "application/x-www-form-urlencoded",
        bodyEncodings: {
          "application/x-www-form-urlencoded": { a: { style: "deepObject", explode: true } },
        },
      },
    })
    for (const method of ["GET", "HEAD"]) {
      expect(entry(code, `${method} /r`)).toContain(
        'body?: { "application/x-www-form-urlencoded": { a?: { [key: string]: unknown } } }',
      )
    }
  })

  it("keeps names such as __proto__ as data", async () => {
    // Parsed from JSON, as documents are: `__proto__` is an ordinary key there.
    const doc = JSON.parse(
      JSON.stringify(
        oas("3.1", {
          paths: {
            "/a": {
              post: {
                parameters: [
                  { name: "PROTO", in: "query", style: "pipeDelimited", schema: { type: "array" } },
                ],
                requestBody: {
                  content: {
                    "application/x-www-form-urlencoded": {
                      schema: { type: "object" },
                      encoding: { PROTO: { style: "deepObject", explode: true } },
                    },
                  },
                },
                responses: ok,
              },
            },
          },
        }),
      ).replaceAll("PROTO", "__proto__"),
    ) as object
    const code = await gen(doc)
    const { endpoints } = await contractOf(code)
    const post = endpoints["POST /a"]
    for (const map of [post?.query, post?.bodyEncodings?.["application/x-www-form-urlencoded"]]) {
      expect(Object.hasOwn(map ?? {}, "__proto__")).toBe(true)
    }
    await expectPassesTsc(code)
  })

  it("records the Encoding Objects of a 3.2 form querystring as its fields' encodings", async () => {
    const code = await gen(
      oas("3.2", {
        paths: {
          "/q": {
            get: {
              parameters: [
                {
                  name: "q",
                  in: "querystring",
                  content: {
                    "application/x-www-form-urlencoded": {
                      schema: { type: "object" },
                      encoding: {
                        filter: { style: "deepObject", explode: true },
                        ids: { explode: false },
                      },
                    },
                  },
                },
              ],
              responses: ok,
            },
          },
        },
      }),
    )
    const { endpoints } = await contractOf(code)
    expect(endpoints["GET /q"]).toStrictEqual({
      query: {
        filter: { style: "deepObject", explode: true },
        ids: { style: "form", explode: false },
      },
    })
  })

  it("is typed in a module that imports nothing, so that its types need nothing installed", async () => {
    const code = await gen(oas("3.1", { paths: { "/a": { get: { responses: ok } } } }))
    expect(code).not.toMatch(/^import /m)
    // Without openapi-shape/client to resolve, as for a client of your own.
    const types = 'import type { Endpoints } from "./api"\nexport type A = Endpoints["GET /a"]\n'
    const tsconfig = {
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "esnext",
        moduleResolution: "bundler",
        types: [],
      },
    }
    expect(
      await typecheck({
        "api.ts": code,
        "use.ts": types,
        "tsconfig.json": JSON.stringify(tsconfig),
      }),
    ).toBe("")
  })
})
