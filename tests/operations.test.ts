import { describe, expect, it } from "vitest"
import { codes, entry, gen, genResult, oas } from "./helpers/generate"
import { expectPassesTsc } from "./helpers/tsc"

const ok = { "200": { description: "OK" } }
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })

describe("methods", () => {
  it("emits every fixed method, uppercase, in Path Item order", async () => {
    const methods = ["trace", "patch", "head", "options", "delete", "post", "put", "get"]
    const code = await gen(
      oas("3.1", {
        paths: { "/r": Object.fromEntries(methods.map((m) => [m, { responses: ok }])) },
      }),
    )
    const keys = [...code.matchAll(/^ {2}"([A-Z]+) \/r"/gm)].map((m) => m[1])
    expect(keys).toStrictEqual([
      "GET",
      "PUT",
      "POST",
      "DELETE",
      "OPTIONS",
      "HEAD",
      "PATCH",
      "TRACE",
    ])
  })

  it("supports QUERY and additionalOperations in 3.2", async () => {
    const result = await genResult(
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
      "ignored-keyword #/paths/~1r/additionalOperations/POST",
    ])
  })

  it("applies 3.2 fields in earlier versions, and says so", async () => {
    const result = await genResult(
      oas("3.1", {
        paths: {
          "/r": { query: { responses: ok }, additionalOperations: { COPY: { responses: ok } } },
        },
      }),
    )
    expect(result.code).toContain('"QUERY /r"')
    expect(result.code).toContain('"COPY /r"')
    expect(codes(result.diagnostics)).toStrictEqual([
      "lenient-keyword #/paths/~1r/query",
      "lenient-keyword #/paths/~1r/additionalOperations",
    ])
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
    expect(entry(code, "GET /users/{id}")).toBe(
      [
        "{",
        "  params: { id: number }",
        "  query: { tags?: string[]; limit: number }",
        "  headers: {",
        "    /** @format uuid */",
        '    "X-Trace"?: string',
        "  }",
        "  cookies: { session: string }",
        "  response: {",
        "    /** OK */",
        '    "200": undefined',
        "  }",
        "}",
      ].join("\n"),
    )
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
    expect(entry(code, "GET /r")).toContain(
      'query: { q: number; keep?: boolean }\n  headers: { "X-ID"?: number }',
    )
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
    expect(entry(code, "GET /r")).not.toContain("headers")
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
    expect(entry(code, "GET /r")).toContain("query: { filter?: { a?: string } }")
  })

  it("matches path parameters to the path template", async () => {
    const result = await genResult(
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
    const result = await genResult(
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
      "lenient-keyword #/paths/~1r~1{id}/get/parameters/5/in",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters/0",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters/3",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters/4",
      "invalid-parameter #/paths/~1r~1{id}/get/parameters",
    ])
  })

  it("types a 3.2 querystring parameter as the whole query", async () => {
    const result = await genResult(
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
    expect(entry(code, "PUT /b")).toContain(
      '/** Either form */\n  body?: { "application/json": { n?: number }; "text/plain": string }',
    )
  })

  it("keeps request bodies on GET, HEAD, and DELETE, warning only for 3.0", async () => {
    const paths = { "/r": { delete: { requestBody: json({ type: "string" }), responses: ok } } }
    const result30 = await genResult(oas("3.0", { paths }))
    expect(entry(result30.code, "DELETE /r")).toContain('body?: { "application/json": string }')
    expect(codes(result30.diagnostics)).toStrictEqual([
      "lenient-request-body #/paths/~1r/delete/requestBody",
    ])
    const result31 = await genResult(oas("3.1", { paths }))
    expect(entry(result31.code, "DELETE /r")).toContain("body?:")
    expect(result31.diagnostics).toStrictEqual([])
  })
})

describe("responses", () => {
  it("keeps status keys, unions media types, and marks empty responses undefined", async () => {
    const result = await genResult(
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
    expect(entry(result.code, "GET /r")).toBe(
      [
        "{",
        "  response: {",
        "    /** Pet */",
        '    "200": { [key: string]: unknown } | string',
        "    /** Nothing */",
        '    "204": undefined',
        "    /** Client error */",
        '    "4XX": string',
        "    /** Other */",
        '    "default": undefined',
        "  }",
        "}",
      ].join("\n"),
    )
    expect(codes(result.diagnostics)).toStrictEqual([
      "invalid-status-code #/paths/~1r/get/responses/4xx",
    ])
  })

  it("merges status keys that differ only in case", async () => {
    const result = await genResult(
      oas("3.1", {
        paths: {
          "/r": {
            get: {
              responses: {
                "2xx": { description: "a", ...json({ type: "string" }) },
                "2XX": { description: "b", ...json({ type: "number" }) },
              },
            },
          },
        },
      }),
    )
    expect(entry(result.code, "GET /r")).toContain('"2XX": string | number')
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
    expect(entry(code, "GET /r")).toContain(
      '  responseHeaders: {\n    "200": {\n      "X-Rate-Limit": number\n      /** Pagination */\n      Link?: string\n    }\n  }',
    )
  })

  it("leaves the response map empty when no responses are declared", async () => {
    expect(entry(await gen(oas("3.1", { paths: { "/r": { get: {} } } })), "GET /r")).toBe(
      "{\n  response: {}\n}",
    )
  })
})

describe("webhooks and callbacks", () => {
  it("emits webhooks, applying them in 3.0 with a warning", async () => {
    const webhooks = {
      "pet.created": { post: { requestBody: json({ type: "string" }), responses: ok } },
    }
    const code = await gen(oas("3.1", { webhooks }))
    expect(code).toContain(
      'export interface Webhooks {\n  "POST pet.created": {\n    body?: { "application/json": string }',
    )
    const result30 = await genResult(oas("3.0", { webhooks }))
    expect(result30.code).toContain('"POST pet.created"')
    expect(codes(result30.diagnostics)).toStrictEqual(["lenient-keyword #/webhooks"])
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
      'response: {\n    /** OK */\n    "200": { count?: number }\n  }',
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
    const result = await genResult(
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
    expect(entry(result.code, "GET /r")).toContain('"201"')
    expect(result.code).toContain('"PUT /r"')
    expect(codes(result.diagnostics)).toStrictEqual(["path-item-conflict #/paths/~1r/get"])
  })
})
