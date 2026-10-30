import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import type { Contract, StreamMessage } from "../../src/client"
import { createClient } from "../../src/client"
import { collectStreamMedia } from "../../src/client/streams/subscription"
import { generate } from "../../src/core/index"
import { contractOf } from "../support/contract"
import { codes, entry, gen, oas } from "../support/generate"
import { sseResponse as response } from "../support/streams"
import { withFiles } from "../support/tmp"
import { expectPassesTsc, typecheck } from "../support/tsc"

const ok = { "200": { description: "OK" } }

const json = (schema: object) => ({ "application/json": { schema } })

const item = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" } },
}

const description = oas("3.1", {
  paths: {
    "/items/{ids}": {
      get: {
        parameters: [
          {
            name: "ids",
            in: "path",
            required: true,
            style: "label",
            explode: true,
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "tags",
            in: "query",
            required: true,
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
          { name: "filter", in: "query", required: true, content: json(item) },
        ],
        responses: {
          "200": { description: "Found", content: json(item) },
          "204": { description: "Empty" },
          "304": { description: "Unchanged" },
          "404": {
            description: "Missing",
            content: json({
              type: "object",
              required: ["message"],
              properties: { message: { type: "string" } },
            }),
          },
        },
      },
    },
    "/items": {
      head: { responses: { "200": { description: "Exists", content: json(item) } } },
      post: {
        requestBody: {
          required: true,
          content: {
            ...json(item),
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["meta", "tags"],
                properties: {
                  meta: item,
                  tags: { type: "array", items: { type: "string" } },
                },
              },
              encoding: {
                meta: { contentType: "application/vnd.meta+json" },
                tags: { style: "form", explode: false },
              },
            },
          },
        },
        responses: { "204": { description: "Created" }, "400": { description: "Rejected" } },
      },
    },
  },
})

// Compile and execute this same consumer. Runtime assertions cannot accidentally exercise
// a different input than the one accepted by the generated public types.
const consumer = `
import { createClient } from "openapi-shape/client"
import type { contract } from "./api"

export async function run(generated: typeof contract, fetch: (request: Request) => Promise<Response>) {
  const api = createClient(generated, { baseURL: "https://api.test", fetch })
  const input = { params: { ids: ["a/b", "c"] }, query: { tags: ["x&y", "z"], filter: { id: 7 } } }
  const results = []
  for (let i = 0; i < 4; i++) {
    const result = await api.result("GET /items/{ids}", input)
    if (result.status === 200) {
      result.data.id satisfies number
      // @ts-expect-error a success is not the error body
      result.data.message
    }
    if (result.status === 204) result.data satisfies undefined
    if (result.status === 304) result.error satisfies null
    if (result.status === 404 && result.error !== null) {
      result.error.message satisfies string
      // @ts-expect-error status narrows to the corresponding body
      result.error.id
    }
    results.push(result)
  }
  const head = await api.result("HEAD /items")
  head.data satisfies undefined
  results.push(head)
  const created = await api.result("POST /items", { body: { id: 7 }, headers: { "content-type": "application/json" } })
  if (created.status === 204) created.data satisfies undefined
  results.push(created)
  const rejected = await api.result("POST /items", { body: { meta: { id: 7 }, tags: ["x&y", "z"] }, headers: { "content-type": "multipart/form-data" } })
  if (rejected.status === 400) rejected.error satisfies null
  results.push(rejected)
  return results
}

// Checked but never executed: the generated contract rejects these at the call site.
export function invalid(generated: typeof contract) {
  const api = createClient(generated)
  // @ts-expect-error required path and query parameters
  api.fetch("GET /items/{ids}")
  // @ts-expect-error filter uses its declared content schema
  api.fetch("GET /items/{ids}", { params: { ids: ["a"] }, query: { tags: [], filter: "raw" } })
  // @ts-expect-error the default application/json body requires id
  api.fetch("POST /items", { body: { meta: { id: 7 }, tags: [] }, headers: { "content-type": "application/json" } })
  // @ts-expect-error explicit media type selects its own body schema
  api.fetch("POST /items", { body: { id: 7 }, headers: { "content-type": "multipart/form-data" } })
  // @ts-expect-error HEAD cannot send a body
  api.fetch("HEAD /items", { body: { id: 7 }, headers: { "content-type": "application/json" } })
}
`

describe("generated request plans", () => {
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
    expect(endpoints).toMatchObject({
      "GET /items/{id}": {
        parameters: {
          path: { id: { required: true, encoding: { style: "label", explode: false } } },
          query: {
            created: { required: false, encoding: { style: "deepObject", explode: true } },
            ids: { required: false, encoding: { style: "pipeDelimited", explode: false } },
            tags: { required: false, encoding: { style: "form", explode: false } },
            next: {
              required: false,
              encoding: { style: "form", explode: true, allowReserved: true },
            },
            filter: { required: false, encoding: { contentType: "application/json" } },
          },
          header: { "X-Range": { required: false, encoding: { style: "simple", explode: true } } },
        },

        responses: { "200": {} },
      },
      "PUT /items/{id}": {
        requestBody: {
          required: false,
          content: {
            "application/x-www-form-urlencoded": {
              encoding: {
                metadata: { style: "deepObject", explode: true },
                plain: { contentType: "text/plain", repeat: true },
                styled: { style: "form", explode: false },
              },
            },
          },
        },
        responses: { "200": {} },
      },
      // Two media types and neither takes JSON: the call names one.
      "POST /items/{id}": {
        requestBody: {
          required: false,
          content: {
            "multipart/form-data": { encoding: { meta: { contentType: "application/json" } } },
          },
        },
        responses: { "200": {} },
      },
      "PATCH /items/{id}": {
        requestBody: { required: false, content: { "application/json": {} } },
        responses: { "200": {} },
      },
    })
    // Server declarations do not choose a baseURL for the client or its calls.
    expect(result.code).toContain("// @server https://api.test/v1\n")
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
    expect(endpoints).toMatchObject({
      "GET /r": { responses: { "200": {} } },
      "HEAD /r": { responses: { "200": {} } },
      "POST /r": {
        requestBody: {
          required: false,
          content: {
            "application/x-www-form-urlencoded": {
              encoding: { a: { style: "deepObject", explode: true } },
            },
          },
        },
        responses: { "200": {} },
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
    for (const map of [
      post?.parameters?.query,
      post?.requestBody?.content["application/x-www-form-urlencoded"]?.encoding,
    ]) {
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
    expect(endpoints["GET /q"]).toMatchObject({
      querystring: {
        required: false,
        content: {
          "application/x-www-form-urlencoded": {
            encoding: {
              filter: { style: "deepObject", explode: true },
              ids: { style: "form", explode: false },
            },
          },
        },
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

  it("preserves a custom method's spelling through generation and transport", async () => {
    const { code } = await generate(
      oas("3.2", {
        paths: { "/custom": { additionalOperations: { CuStOm: { responses: { "204": {} } } } } },
      }),
    )
    const contract = await contractOf(code)
    expect(contract.endpoints["CuStOm /custom"]).toStrictEqual({ responses: { "204": {} } })
    const api = createClient(contract, {
      baseURL: "https://api.test",
      fetch: (request) => {
        expect(request.method).toBe("CuStOm")
        return Promise.resolve(new Response(null, { status: 204 }))
      },
    })
    await api.fetch("CuStOm /custom")
  })
})

describe("contract integration", () => {
  it("preserves one generated protocol contract through type checking, encoding and decoding", async () => {
    const { code, diagnostics } = await generate(description)
    expect(diagnostics).toStrictEqual([])
    const clientPath = join(import.meta.dirname, "../../src/client/index.ts")
    expect(
      await typecheck(
        {
          "api.ts": code,
          "consumer.ts": consumer,
        },
        { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
      ),
    ).toBe("")

    const contract = await contractOf(code)
    const requests: Request[] = []
    const responses = [
      Response.json({ id: 7 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 304 }),
      Response.json({ message: "missing" }, { status: 404 }),
      // Even if an injected transport supplies bytes, HEAD cannot expose a decoded body.
      Response.json({ id: 99 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 400 }),
    ]
    const results = await withFiles(
      { "consumer.ts": consumer.replace('"openapi-shape/client"', JSON.stringify(clientPath)) },
      async (dir) => {
        const { run } = (await import(pathToFileURL(join(dir, "consumer.ts")).href)) as {
          run: (
            generated: Contract,
            fetch: (request: Request) => Promise<Response>,
          ) => Promise<unknown[]>
        }
        return run(contract, (request) => {
          requests.push(request)
          const nextResponse = responses.shift()
          if (!nextResponse) throw new Error("Unexpected extra request")
          return Promise.resolve(nextResponse)
        })
      },
    )
    expect(responses).toHaveLength(0)
    expect(results).toMatchObject([
      { status: 200, data: { id: 7 }, error: undefined },
      { status: 204, data: undefined, error: undefined },
      { status: 304, data: undefined, error: null },
      { status: 404, data: undefined, error: { message: "missing" } },
      { status: 200, data: undefined, error: undefined },
      { status: 204, data: undefined, error: undefined },
      { status: 400, data: undefined, error: null },
    ])
    expect(requests.slice(0, 4).map((request) => request.url)).toStrictEqual(
      Array(4).fill("https://api.test/items/.a%2Fb.c?tags=x%26y,z&filter=%7B%22id%22%3A7%7D"),
    )
    expect(requests[4].method).toBe("HEAD")
    expect(requests[4].body).toBeNull()
    expect(requests[5].headers.get("content-type")).toBe("application/json")
    expect(await requests[5].json()).toStrictEqual({ id: 7 })
    expect(requests[6].headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
    const parts = await requests[6].formData()
    expect([...parts.keys()]).toStrictEqual(["meta", "tags"])
    const meta = parts.get("meta")
    expect(meta).toBeInstanceOf(Blob)
    if (!(meta instanceof Blob)) throw new Error("Expected a typed JSON part")
    expect(meta.type).toBe("application/vnd.meta+json")
    expect(await meta.text()).toBe('{"id":7}')
    expect(parts.get("tags")).toBe("x&y,z")
  })
})

describe("stream contracts", () => {
  it("keeps generated classification, inferred events and runtime behavior aligned", async () => {
    const sse = {
      description: "events",
      content: {
        "Text/Event-Stream; charset=utf-8": {
          itemSchema: {
            oneOf: [
              {
                type: "object",
                required: ["event", "data"],
                properties: { event: { const: "added" }, data: { type: "string" } },
              },
              {
                type: "object",
                required: ["event", "data"],
                properties: {
                  event: { const: "removed" },
                  data: { type: "string", enum: ["gone"] },
                },
              },
            ],
          },
        },
      },
    }
    const jsonContent = {
      description: "json",
      content: { "application/json": { schema: { type: "number" } } },
    }
    const { code, diagnostics } = await generate(
      oas("3.2", {
        paths: {
          "/events/{id}": {
            post: {
              parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["topic"],
                      properties: { topic: { type: "string" } },
                    },
                  },
                },
              },
              responses: { "200": sse, 400: jsonContent },
            },
          },
          "/mixed": {
            get: {
              responses: { "200": { ...sse, content: { ...sse.content, ...jsonContent.content } } },
            },
          },
          "/impossible": {
            get: {
              responses: {
                "200": {
                  description: "no valid data",
                  content: {
                    "text/event-stream": { schema: { type: "string", enum: [] } },
                  },
                },
              },
            },
          },
          "/fallback": { get: { responses: { default: sse } } },
          "/ordinary": { get: { responses: { "200": jsonContent, "default": sse } } },
          "/error-only": { get: { responses: { 400: sse } } },
          "/empty": { get: { responses: { 204: sse, 205: sse } } },
          "/head": { head: { responses: { "200": sse } } },
          "/range": { get: { responses: { "2XX": sse, 200: jsonContent } } },
          "/shadowed": {
            get: {
              responses: {
                "2XX": sse,
                ...Object.fromEntries(
                  Array.from({ length: 100 }, (_, i) => [200 + i, jsonContent]),
                ),
              },
            },
          },
          "/wildcard": {
            get: { responses: { "200": { description: "wild", content: { "text/*": {} } } } },
          },
        },
      }),
    )
    expect(diagnostics).toStrictEqual([])
    const contract = await contractOf(code)
    expect(collectStreamMedia(contract.endpoints["GET /ordinary"])).toStrictEqual([
      "Text/Event-Stream; charset=utf-8",
    ])
    expect(collectStreamMedia(contract.endpoints["GET /mixed"])).toStrictEqual([
      "Text/Event-Stream; charset=utf-8",
    ])
    const streams = Object.entries(contract.endpoints)
      .filter(([key, plan]) => collectStreamMedia(plan, key.split(" ")[0]).length > 0)
      .map(([key]) => key)
    expect(streams.toSorted()).toStrictEqual([
      "GET /fallback",
      "GET /impossible",
      "GET /mixed",
      "GET /ordinary",
      "GET /range",
      "POST /events/{id}",
    ])
    expect(
      await typecheck(
        {
          "api.ts": code,
          "use.ts": `
import { createClient } from "openapi-shape/client"
import type { Client, EndpointData, EndpointMessage, ResultEndpoint, StreamEndpoint, StreamArgs, StreamMedia } from "openapi-shape/client"
import { contract, type Endpoints } from "./api"
const api = createClient(contract)
const keys: StreamEndpoint<Endpoints>[] = ["GET /fallback", "GET /mixed", "GET /range", "POST /events/{id}"]
void api.stream("GET /impossible")
// @ts-expect-error SSE classification is independent of its schema admitting values
void api.result("GET /impossible")
for await (const event of api.stream("POST /events/{id}", { params: { id: 1 }, body: { topic: "orders" }, headers: { "content-type": "application/json" } })) {
  event.data satisfies string
  event.event satisfies "added" | "removed"
  if (event.event === "removed") event.data satisfies "gone"
}
// @ts-expect-error required inputs
void api.stream("POST /events/{id}")
// @ts-expect-error wrong path parameter
void api.stream("POST /events/{id}", { params: { id: "wrong" }, body: { topic: "orders" }, headers: { "content-type": "application/json" } })
// @ts-expect-error a stream request body cannot be replayed
void api.stream("POST /events/{id}", { params: { id: 1 }, body: new ReadableStream(), reconnect: {}, headers: { "content-type": "application/json" } })
void api.result("GET /mixed")
type MixedData = EndpointData<Endpoints, "GET /mixed">
void api.stream("GET /ordinary")
// @ts-expect-error unknown endpoint
void api.stream("GET /missing")
// @ts-expect-error a call cannot mix operations
void api.stream(Math.random() ? "GET /mixed" : "GET /fallback")
void api.fetch("GET /mixed")
${["error-only", "empty", "head", "shadowed", "wildcard"]
  .map(
    (name) => `
${name === "error-only" ? "// @ts-expect-error only streaming error content can never complete" : ""}
void api.result("${name === "head" ? "HEAD" : "GET"} /${name}")
// @ts-expect-error not a stream
void api.stream("${name === "head" ? "HEAD" : "GET"} /${name}")`,
  )
  .join("\n")}
function wrap<K extends StreamEndpoint<Endpoints>>(key: K, ...args: StreamArgs<Endpoints, K>) { return api.stream(key, ...args) }
void wrap("GET /mixed")
type E = EndpointMessage<Endpoints, "GET /mixed">
declare const message: E
message.data satisfies string
`,
        },
        { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
      ),
    ).toBe("")
    const api = createClient(contract, {
      baseURL: "https://example.test",
      fetch: () => Promise.resolve(response("event: removed\ndata: gone\n\n")),
    })
    const messages: StreamMessage[] = []
    // contractOf intentionally erases compile-time operations; the generated consumer above checks them.
    for await (const event of api.stream(
      "POST /events/{id}" as never,
      {
        params: { id: 3 },
        headers: { "content-type": "application/json" },
        body: { topic: "orders" },
        reconnect: false,
      } as never,
    ))
      messages.push(event as StreamMessage)
    expect(messages).toStrictEqual([{ event: "removed", data: "gone", id: "" }])
  })
})
