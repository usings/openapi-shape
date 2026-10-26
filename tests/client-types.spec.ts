import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createClient } from "../src/client"
import { generate } from "../src/core/index"
import { contractOf } from "./helpers/contract"
import { oas } from "./helpers/generate"
import { typecheck } from "./helpers/tsc"

const jsonResponse = (schema: unknown) => ({
  description: "Response",
  content: { "application/json": { schema } },
})

async function responseApi(responses: Array<Record<string, unknown>>) {
  const { code, diagnostics } = await generate(
    oas("3.1", {
      paths: Object.fromEntries(
        responses.map((response, i) => [`/${i}`, { get: { responses: response } }]),
      ),
    }),
  )
  expect(diagnostics).toStrictEqual([])
  return code
}

describe("call types", () => {
  it("derives request inputs and status narrowing from flat descriptive operations", async () => {
    expect(
      await typecheck({
        "use.ts": `
import type { Client } from "openapi-shape/client"
type Json<T> = { content: { "application/json": T } }
interface Endpoints {
  "POST /items": {
    params: { id: string }
    body: { "application/json": { name: string }; "text/plain": "ready" }
    responses: {
      200: Json<{ exact: true }>
      "2XX": Json<{ ranged: true }>
      404: Json<{ missing: true }>
      "4XX": Json<{ failed: true }>
      default: Json<{ fallback: true }>
    }
  }
  "GET /impossible": { responses: { 200: Json<never> } }
}
declare const api: Client<Endpoints>
void api.result("POST /items", { params: { id: "a" }, body: { name: "a" } })
void api.result("POST /items", { params: { id: "a" }, contentType: "text/plain", body: "ready" })
// @ts-expect-error flat params remain required
void api.result("POST /items", { body: { name: "a" } })
// @ts-expect-error required body remains required
void api.result("POST /items", { params: { id: "a" } })
// @ts-expect-error request media selects its own body shape
void api.result("POST /items", { params: { id: "a" }, contentType: "text/plain", body: { name: "a" } })
async function check() {
  const result = await api.result("POST /items", { params: { id: "a" }, body: { name: "a" } })
  if (result.status === 200) result.data satisfies { exact: true }
  if (result.status === 201) result.data satisfies { ranged: true }
  if (result.status === 204 || result.status === 205) result.data satisfies undefined
  if (result.status === 404) result.error satisfies { missing: true }
  if (result.status === 405) result.error satisfies { failed: true }
  if (result.status === 500) result.error satisfies { fallback: true }
  if (result.status === 304) result.error satisfies null
  const response = await api.fetch("POST /items", { params: { id: "a" }, body: { name: "a" } })
  if (response.status === 200) response.json() satisfies Promise<{ exact: true }>
  if (response.status === 201) response.json() satisfies Promise<{ ranged: true }>
  if (response.status === 404) response.json() satisfies Promise<{ missing: true }>
  const impossible = await api.fetch("GET /impossible")
  if (impossible.status === 200) impossible.json() satisfies Promise<never>
}
`,
      }),
    ).toBe("")
  })

  it("distinguishes required whole queries from optional ordinary query parameters", async () => {
    const paths = Object.fromEntries(
      [
        [
          "/required",
          [
            {
              name: "whole",
              in: "querystring",
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", properties: { q: { type: "string" } } },
                },
              },
            },
          ],
        ],
        [
          "/optional",
          [
            {
              name: "whole",
              in: "querystring",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["q"],
                    properties: { q: { type: "string" } },
                  },
                },
              },
            },
          ],
        ],
        ["/ordinary", [{ name: "q", in: "query", schema: { type: "string" } }]],
        [
          "/ordinary-required",
          [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        ],
      ].map(([path, parameters]) => [
        path,
        { get: { parameters, responses: { "204": { description: "ok" } } } },
      ]),
    )
    const { code, diagnostics } = await generate(oas("3.2", { paths }))
    expect(diagnostics).toStrictEqual([])
    expect(
      await typecheck(
        {
          "api.ts": code,
          "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
// @ts-expect-error required querystring cannot be omitted even if its properties can
void api.fetch("GET /required")
// @ts-expect-error both client entry points require the whole query
void api.result("GET /required", {})
void api.fetch("GET /required", {query: {}})
void api.result("GET /optional")
void api.fetch("GET /optional", {query: {q: "ok"}})
// @ts-expect-error optional whole-query presence does not relax its required properties
void api.fetch("GET /optional", {query: {}})
void api.fetch("GET /ordinary")
void api.result("GET /ordinary", {})
// @ts-expect-error required ordinary parameters still require query
void api.fetch("GET /ordinary-required")
void api.fetch("GET /ordinary-required", {query: {q: "ok"}})
`,
        },
        { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
      ),
    ).toBe("")
  })

  it("compiles fetch method restrictions and GET body omission", async () => {
    const { code } = await generate(
      oas("3.2", {
        paths: {
          "/search": {
            get: {
              requestBody: {
                required: true,
                content: { "application/json": { schema: { type: "object" } } },
              },
              responses: {
                "200": {
                  description: "ok",
                  content: { "application/json": { schema: { type: "string" } } },
                },
              },
            },
          },
          "/debug": {
            trace: {
              responses: {
                "200": {
                  description: "ok",
                  content: { "application/json": { schema: { type: "string" } } },
                },
              },
            },
          },
          "/tunnel": {
            additionalOperations: {
              connect: {
                responses: {
                  "200": {
                    description: "ok",
                    content: { "application/json": { schema: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      }),
    )
    expect(
      await typecheck({
        "api.ts": code,
        "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
void api.result("GET /search")
// @ts-expect-error GET does not send a body
void api.result("GET /search", { body: {} })
// @ts-expect-error fetch refuses TRACE
void api.fetch("TRACE /debug")
// @ts-expect-error fetch refuses CONNECT
void api.fetch("CONNECT /tunnel")
`,
      }),
    ).toBe("")
  })

  it("reports unknown endpoints instead of a missing init argument", async () => {
    const diagnostics = await typecheck({
      "api.ts": await readFile(join(import.meta.dirname, "__snapshots__/client-api.ts"), "utf8"),
      "use.ts": [
        'import { createClient } from "openapi-shape/client"',
        'import { contract } from "./api"',
        "const api = createClient(contract)",
        'void api.result("GET /nope")',
        'void api.fetch("GET /nope")',
        'void api.result("GET /nope", {})',
        'void api.fetch("GET /nope", {})',
      ].join("\n"),
    })
    expect(diagnostics.match(/error TS2345/g)).toHaveLength(4)
    expect(diagnostics).toContain(`Argument of type '"GET /nope"'`)
    expect(diagnostics).not.toContain("Expected 2 arguments")
  })
})

describe("response types", () => {
  it("preserves projected string alternatives alongside structured wildcard responses", async () => {
    const { code } = await generate(
      oas("3.1", {
        paths: Object.fromEntries(
          ["*/*", "application/*"].map((media, i) => [
            `/mixed${i}`,
            {
              get: {
                responses: {
                  "200": {
                    description: "mixed",
                    content: {
                      [media]: {
                        schema: {
                          anyOf: [
                            { type: "string", format: "binary" },
                            {
                              type: "object",
                              properties: { id: { type: "number" } },
                              required: ["id"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          ]),
        ),
      }),
    )
    expect(
      await typecheck({
        "api.ts": code,
        "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
async function use() {
  const response = await api.fetch("GET /mixed0")
  if (response.ok) {
    const data = await response.json()
    data satisfies string | { id: number }
    // @ts-expect-error a string alternative does not have the object fields
    data.id.toFixed()
  }
  const result = await api.result("GET /mixed1")
  if (result.status === 200) {
    const data = await result.response.json()
    data satisfies string | { id: number }
    // @ts-expect-error result.response preserves the same string alternative
    data.id.toFixed()
  }
}
`,
      }),
    ).toBe("")
    const api = createClient(await contractOf(code), {
      baseURL: "https://api.test",
      fetch: () => Promise.resolve(Response.json("raw")),
    })
    const response = await api.fetch("GET /mixed0")
    expect(await response.json()).toBe("raw")
  })

  it("treats 304 as empty across explicit, range, default, and undeclared responses", async () => {
    const responses = [
      { "304": jsonResponse({ type: "object", properties: { message: { type: "string" } } }) },
      { "3XX": jsonResponse(true) },
      { default: jsonResponse(false) },
      { "200": jsonResponse({ type: "array", items: { type: "string" } }) },
    ]
    const calls = responses.map(
      (_, i) => `
  const result${i} = await api.result("GET /${i}")
  if (result${i}.status === 304) {
    result${i}.data satisfies undefined
    result${i}.error satisfies null
    result${i}.response.ok satisfies false
    result${i}.response.json() satisfies Promise<never>
    // @ts-expect-error a 304 never has a decoded error body
    result${i}.error.message
  }
  const response${i} = await api.fetch("GET /${i}")
  if (response${i}.status === 304) response${i}.json() satisfies Promise<never>
`,
    )
    expect(
      await typecheck({
        "api.ts": await responseApi(responses),
        "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
async function use() { ${calls.join("\n")} }
`,
      }),
    ).toBe("")
  })

  it("keeps successes when a declared error body is never", async () => {
    const result = await typecheck({
      "api.ts": await responseApi([
        { "200": jsonResponse({ type: "string" }), "404": jsonResponse(false) },
        { default: jsonResponse(false) },
      ]),
      "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
async function use() {
  const found = await api.result("GET /0")
  if (found.error === undefined) {
    found.data.toUpperCase()
    found.status satisfies 200
    found.response.json() satisfies Promise<string>
  }
  const impossible = await api.result("GET /1")
  if (impossible.status === 204) {
    impossible.data satisfies undefined
    impossible.response.json() satisfies Promise<never>
  }
  if (impossible.status === 200) impossible.data satisfies never
}
`,
    })
    expect(result).toBe("")
  })

  it("keeps success data correlated with each status without intersecting sibling bodies", async () => {
    const result = await typecheck({
      "api.ts": await responseApi([
        {
          "200": jsonResponse({ type: "array", items: { type: "string" } }),
          "206": jsonResponse({ type: "array", items: { type: "number" } }),
        },
        {
          "200": jsonResponse({ type: "array", items: { type: "string" } }),
          "206": jsonResponse(true),
        },
      ]),
      "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
async function use() {
  const { data, error, status } = await api.result("GET /0")
  if (error === undefined) {
    data.find(value => value === 1) satisfies string | number | undefined
    data.map(value => String(value)) satisfies string[]
  }
  if (status === 200) {
    data.map(value => value.toUpperCase()) satisfies string[]
    // @ts-expect-error a 200 body contains strings
    data.push(1)
  }
  if (status === 206) {
    data.find(value => value > 0) satisfies number | undefined
    // @ts-expect-error a 206 body contains numbers
    data.push("wrong")
  }
  const mixed = await api.result("GET /1")
  if (mixed.status === 200) {
    mixed.data.map(value => value.toUpperCase()) satisfies string[]
    // @ts-expect-error a sibling's unknown must not erase this body's type
    mixed.data.push(1)
    // @ts-expect-error this body is not unknown
    const wrong: number = mixed.data
  }
}

`,
    })
    expect(result).toBe("")
  })

  it("compiles wildcard, binary, HEAD, empty and default response semantics", async () => {
    const cases = [
      [
        "/download",
        "get",
        {
          "200": {
            description: "bytes",
            content: { "*/*": { schema: { type: "string", format: "binary" } } },
          },
        },
      ],
      [
        "/report",
        "get",
        {
          "200": {
            description: "report",
            content: {
              "*/*": {
                schema: {
                  type: "object",
                  required: ["rows"],
                  properties: { rows: { type: "number" } },
                },
              },
            },
          },
        },
      ],
      ["/bytes", "get", { "200": jsonResponse({ type: "string", format: "binary" }) }],
      ["/pets", "head", { "200": jsonResponse({ type: "array", items: { type: "string" } }) }],
      [
        "/pets",
        "delete",
        { "204": jsonResponse({ type: "string" }), "default": { description: "empty" } },
      ],
      [
        "/default",
        "delete",
        {
          default: jsonResponse({
            type: "object",
            required: ["message"],
            properties: { message: { type: "string" } },
          }),
        },
      ],
    ] as const
    const paths: Record<string, Record<string, unknown>> = {}
    for (const [path, method, responses] of cases) {
      paths[path] ??= {}
      paths[path][method] = { responses }
    }
    const { code } = await generate(oas("3.1", { paths }))
    expect(
      await typecheck({
        "api.ts": code,
        "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const edge = createClient(contract)
async function check() {
  const download = await edge.result("GET /download")
  if (download.error === undefined) {
    download.data satisfies string | Blob
    // @ts-expect-error a string or Blob is not the report object
    download.data.rows
  }
  const downloaded = await edge.fetch("GET /download")
  if (downloaded.ok) {
    const json = await downloaded.json()
    json satisfies string
    // @ts-expect-error the JSON schema declares a string
    json.rows
  }
  const report = await edge.result("GET /report")
  if (report.error === undefined) report.data satisfies { rows: number } | string | Blob
  const bytes = await edge.result("GET /bytes")
  if (bytes.error === undefined) {
    bytes.data satisfies string
    // @ts-expect-error binary format still describes a string in JSON
    bytes.data.rows
  }
  const head = await edge.result("HEAD /pets")
  if (head.error === undefined) head.data satisfies undefined
  const headed = await edge.fetch("HEAD /pets")
  if (headed.ok) headed.json() satisfies Promise<never>
  const removed = await edge.result("DELETE /pets")
  if (removed.error === undefined) removed.data satisfies undefined
  const dropping = await edge.fetch("DELETE /default")
  if (dropping.ok) dropping.json() satisfies Promise<{ message: string }>
  const dropped = await edge.result("DELETE /default")
  if (dropped.status === 204) dropped.data satisfies undefined
  if (dropped.status === 200) dropped.data satisfies { message: string }
}
`,
      }),
    ).toBe("")
  })
})

describe("generic wrappers", () => {
  it("keeps endpoint correlations through cross-file wrappers under stricter optional and index checks", async () => {
    expect(
      await typecheck(
        {
          "api.ts": await readFile(
            join(import.meta.dirname, "__snapshots__/client-api.ts"),
            "utf8",
          ),
          ...Object.fromEntries(
            ["whole", "destructured"].map((style) => {
              const binding = style === "whole" ? "response" : "{ data, error, status }"
              const field = style === "whole" ? "response." : ""
              return [
                `${style}.ts`,
                `
import { createClient } from "openapi-shape/client"
import type { ResultEndpoint, EndpointArgs, EndpointData } from "openapi-shape/client"
import { contract, type Endpoints } from "./api"
const { result } = createClient(contract)
export async function data<K extends ResultEndpoint<Endpoints>>(
  endpoint: K, ...args: EndpointArgs<Endpoints, K>
): Promise<EndpointData<Endpoints, K>> {
  const ${binding} = await result(endpoint, ...args)
  // @ts-expect-error an unchecked result may be a failure
  const unchecked: EndpointData<Endpoints, K> = ${field}data
  // @ts-expect-error an error body is not successful data
  const wrong: EndpointData<Endpoints, K> = ${field}error
  if (${field}error !== undefined) throw new Error(String(${field}status), { cause: ${field}error })
  return ${field}data
}
`,
              ]
            }),
          ),
          "use.ts": `
import { data } from "./destructured"
import { data as whole } from "./whole"
async function run() {
  const pet = await data("GET /pets/{id}", { params: { id: 1 } })
  if (!(pet instanceof Blob)) pet.id satisfies number
  const other = await whole("GET /pets/{id}", { params: { id: 1 } })
  if (!(other instanceof Blob)) other.id satisfies number
  // @ts-expect-error the wrapper preserves required parameters
  await data("GET /pets/{id}")
  // @ts-expect-error another endpoint's inputs do not become legal through a wrapper
  await data("GET /pets/{id}", { query: { q: "pet" } })
  const endpoint = Math.random() ? "GET /pets/{id}" : "GET /search"
  // @ts-expect-error a union would lose the endpoint/input correlation
  await data(endpoint, { params: { id: 1 } })
}
`,
        },
        { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
      ),
    ).toBe("")
  })

  it("checks stream limits and generic wrappers under strict optional and index settings", async () => {
    const assertions = await readFile(join(import.meta.dirname, "types/stream.ts"), "utf8")
    expect(
      await typecheck(
        {
          "stream.ts": assertions.replace('from "../../src/client"', 'from "openapi-shape/client"'),
        },
        { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
      ),
    ).toBe("")
  })

  it("checks 300 heterogeneous endpoints directly and through both generic wrapper forms", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => i)
    const { code, diagnostics } = await generate(
      oas("3.1", {
        paths: Object.fromEntries(
          ids.map((i) => [
            `/resource-${i}/{id}`,
            {
              get: {
                parameters: [
                  { name: "id", in: "path", required: true, schema: { type: "number" } },
                ],
                responses: {
                  "200": jsonResponse({
                    type: "array",
                    items: {
                      type: "object",
                      required: ["kind", "name", "detail"],
                      properties: {
                        kind: { const: `resource-${i}` },
                        name: { type: "string" },
                        detail: {
                          type: "object",
                          required: ["value", "tags"],
                          properties: {
                            value: { const: i },
                            tags: { type: "array", items: { type: "string" } },
                          },
                        },
                      },
                    },
                  }),
                  "206": jsonResponse({ type: "array", items: { type: "number" } }),
                  "404": jsonResponse({
                    type: "object",
                    required: ["message", "code"],
                    properties: {
                      message: { type: "string" },
                      code: { const: i },
                    },
                  }),
                },
              },
            },
          ]),
        ),
      }),
    )
    expect(diagnostics).toStrictEqual([])
    const calls = ids.map(
      (i) => `
  async function call${i}() {
    const r${i} = await client.result("GET /resource-${i}/{id}", { params: { id: 1 } })
    if (r${i}.status === 200) {
      r${i}.data.map(value => value.detail.value) satisfies ${i}[]
      r${i}.data.find(value => value.kind === "resource-${i}")?.detail.tags satisfies string[] | undefined
      // @ts-expect-error a sibling endpoint's body is not this endpoint's
      r${i}.data[0].kind satisfies "resource-${i + 1}"
    }
    if (r${i}.status === 206) r${i}.data.find(value => value > 0) satisfies number | undefined
    if (r${i}.status === 404) r${i}.error.code satisfies ${i}
  }`,
    )
    const wrappers = ["destructured", "whole"].map((style) => {
      const binding = style === "whole" ? "result" : "{ data, error, status, response }"
      const field = style === "whole" ? "result." : ""
      return `
  async function checked_${style}<K extends ResultEndpoint<Endpoints>>(
    endpoint: K, ...args: EndpointArgs<Endpoints, K>
  ): Promise<EndpointData<Endpoints, K>> {
    const ${binding} = await client.result(endpoint, ...args)
    ${field}status satisfies number
    ${field}response satisfies Response
    // @ts-expect-error unchecked data still includes a failure's undefined
    const unchecked: EndpointData<Endpoints, K> = ${field}data
    // @ts-expect-error an error body is not successful data
    const wrong: EndpointData<Endpoints, K> = ${field}error
    if (${field}status === 200) {
      ${field}data.map(value => value.name.toUpperCase()) satisfies string[]
      ${field}response.status satisfies 200
      ${field}response.json() satisfies Promise<{ kind: string; name: string; detail: { value: number; tags: string[] } }[]>
    }
    if (${field}status === 206) {
      ${field}data.find(value => value > 0) satisfies number | undefined
      ${field}response.status satisfies 206
      ${field}response.json() satisfies Promise<number[]>
    }
    if (${field}error !== undefined) throw new Error(String(${field}status))
    ${field}response.ok satisfies true
    ${field}status satisfies 200 | 206
    return ${field}data
  }
  `
    })
    expect(
      await typecheck({
        "api.ts": code,
        "use.ts": `
  import { createClient } from "openapi-shape/client"
  import type { ResultEndpoint, EndpointArgs, EndpointData } from "openapi-shape/client"
  import { contract, type Endpoints } from "./api"
  const client = createClient(contract)
  ${calls.join("\n")}
  ${wrappers.join("\n")}
  async function wrappedCalls() {
    const first = await checked_whole("GET /resource-0/{id}", { params: { id: 1 } })
    first satisfies EndpointData<Endpoints, "GET /resource-0/{id}">
    const last = await checked_destructured("GET /resource-299/{id}", { params: { id: 1 } })
    last satisfies EndpointData<Endpoints, "GET /resource-299/{id}">
  }
  `,
      }),
    ).toBe("")
  })
})

describe("platform types", () => {
  it.each(["dom", "node"] as const)(
    "type-checks exact optional properties with %s platform types",
    async (platform) => {
      const root = join(import.meta.dirname, "..")
      const result = await typecheck({
        "api.ts": await readFile(join(import.meta.dirname, "__snapshots__/client-api.ts"), "utf8"),
        "use.ts": [
          'import { createClient } from "openapi-shape/client"',
          'import { contract } from "./api"',
          'const api = createClient(contract, { baseURL: "https://api.test" })',
          "createClient(contract, { baseURL: undefined })",
          'void api.fetch("GET /pets", { baseURL: undefined })',
          'void api.result("GET /pets", { baseURL: new URL("https://other.test") })',
          'void api.stream("GET /events", { baseURL: undefined, retry: false })',
          'void api.fetch("PATCH /pets/{id}", { params: { id: 1 } })',
          'void api.fetch("PATCH /pets/{id}", { params: { id: 1 }, body: undefined })',
          "export async function use(): Promise<{ id: number }[] | undefined> {",
          '  const response = await api.fetch("GET /pets/{id}", { params: { id: 1 } })',
          "  if (response.status === 404) (await response.json()) satisfies { message?: string }",
          '  const { data } = await api.result("GET /pets", { signal: AbortSignal.timeout(1) })',
          "  return data",
          "}",
        ].join("\n"),
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            target: "esnext",
            module: "esnext",
            moduleResolution: "bundler",
            lib: platform === "dom" ? ["esnext", "dom"] : ["esnext"],
            types: platform === "node" ? ["node"] : [],
            typeRoots: [join(root, "node_modules/@types")],
            skipLibCheck: true,
            paths: { "openapi-shape/client": [join(root, "src/client/index.ts")] },
          },
        }),
      })
      expect(result).toBe("")
    },
  )
})
