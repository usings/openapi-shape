import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, expectTypeOf, it } from "vitest"
import type {
  Client,
  Endpoint,
  EndpointArgs,
  EndpointData,
  Middleware,
  ResultEndpoint,
  TypedResponse,
} from "../src/client"
import { createClient, defineMiddleware } from "../src/client"
import { generate } from "../src/core/index"
import type { Endpoints, Schemas } from "./__snapshots__/client-api"
import { contract } from "./__snapshots__/client-api"
import { contractOf } from "./helpers/contract"
import { oas } from "./helpers/generate"
import { typecheck } from "./helpers/tsc"

// Compile-time checks below are checked by `pnpm typecheck`; their bodies never run.
void function inputChecks(client: Client<Endpoints>): void {
  // @ts-expect-error path parameters are required
  void client.result("GET /pets/{id}")
  // @ts-expect-error parameter types are checked
  void client.result("GET /pets/{id}", { params: { id: "1" } })
  // @ts-expect-error a required query parameter
  void client.fetch("GET /search", { query: {} })
  // @ts-expect-error no request body on this operation
  void client.fetch("GET /pets", { body: {} })
  // @ts-expect-error the body is required
  void client.result("POST /pets")
  // @ts-expect-error body type is checked
  void client.result("POST /pets", { body: { name: 1 } })
  // An optional body can be omitted.
  void client.result("PATCH /pets/{id}", { params: { id: 1 } })
  // @ts-expect-error the body is still checked
  void client.result("POST /charges", { body: { amount: "1" } })
  // @ts-expect-error two media types and no JSON: the call names one
  void client.result("POST /upload", { body: { file: new Blob([]) } })
  void client.result("POST /upload", {
    contentType: "multipart/form-data",
    body: { file: new Blob([]) },
  })
  // @ts-expect-error the body must match the chosen media type
  void client.result("POST /upload", { contentType: "multipart/form-data", body: { name: "x" } })
  void client.result("POST /token", {
    // @ts-expect-error only declared media types
    contentType: "application/json",
    body: { grant_type: "x" },
  })
  // @ts-expect-error a query of undeclared parameters
  void client.result("GET /search", { query: { q: "x", size: 10 } })
  // @ts-expect-error declared headers in an object keep their types
  void client.result("GET /files/{names}", { params: { names: [] }, headers: { "X-Range": 1 } })
  // @ts-expect-error cookies are the runtime's (a browser sends its own)
  void client.result("GET /pets/{id}", { params: { id: 1 }, cookies: { session: "s" } })

  // An encoded form body is taken as it is.
  void client.result("POST /token", { body: "grant_type=client_credentials" })

  // A sync iterable is not a body fetch sends.
  const iterable = [new Uint8Array()][Symbol.iterator]()
  // @ts-expect-error a sync iterable is sent as nothing useful
  void client.fetch("POST /upload", { contentType: "application/octet-stream", body: iterable })
}

void function endpointChecks(client: Client<Endpoints>): void {
  // A call names one endpoint: a union would mix their inputs and responses,
  // also of every endpoint at once.
  const every = "GET /pets/{id}" as Endpoint<Endpoints>
  // @ts-expect-error not one endpoint
  void client.result(every)
  const either = Math.random() > 0.5 ? "GET /pets/{id}" : "GET /pets"
  // @ts-expect-error not one endpoint
  void client.result(either, { params: { id: 1 } })
  // @ts-expect-error not one endpoint
  void client.result(either)
}

void function clientOptionChecks(): void {
  void createClient(contract, { baseUrl: new URL("https://api.test"), fetch: globalThis.fetch })
  // @ts-expect-error one signal would cancel every request; a call or the fetch option takes it
  void createClient(contract, { signal: AbortSignal.timeout(10_000) })
  // @ts-expect-error contract entries name declared endpoints
  void createClient<Endpoints>({ version: 5, endpoints: { "GET /nope": {} } })
  // @ts-expect-error an older contract must be regenerated
  void createClient({ ...contract, version: 1 })
  // @ts-expect-error a newer contract must be regenerated with the installed package
  void createClient({ ...contract, version: 999 })
}

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

// Compile-time checks below are checked by `pnpm typecheck`; their bodies never run.
void async function fetchTypeChecks(client: Client<Endpoints>): Promise<void> {
  const pet = await client.fetch("GET /pets/{id}", { params: { id: 1 } })
  if (pet.ok) expectTypeOf(await pet.json()).toEqualTypeOf<Schemas.Pet>()
  if (pet.status === 404) expectTypeOf(await pet.json()).toEqualTypeOf<Schemas.Error>()
  // Undeclared error statuses have unknown bodies.
  if (pet.status === 500) expectTypeOf(await pet.json()).toEqualTypeOf<unknown>()
  expectTypeOf(pet).toExtend<Response>()

  // A declared 2xx is the only success; `default` covers every other status.
  const pets = await client.fetch("GET /pets")
  if (pets.ok) expectTypeOf(await pets.json()).toEqualTypeOf<Schemas.Pet[]>()
  if (!pets.ok) expectTypeOf(await pets.json()).toEqualTypeOf<Schemas.Error>()
  expectTypeOf<201>().not.toExtend<typeof pets.status>()

  // A range stands for each of its statuses; text content has no typed `json()`.
  const search = await client.fetch("GET /search", { query: { q: "x" } })
  if (search.ok) {
    expectTypeOf(await search.json()).toEqualTypeOf<unknown>()
    // A 204 has nothing for `json()` to resolve to: it rejects.
    if (search.status === 204) expectTypeOf(await search.json()).toEqualTypeOf<never>()
    expectTypeOf<299>().toExtend<typeof search.status>()
    expectTypeOf(search).toExtend<TypedResponse<number, true, unknown>>()
  }

  // Without any declared success, a 2xx body is unknown.
  const health = await client.fetch("GET /health")
  if (health.ok) expectTypeOf(await health.json()).toEqualTypeOf<unknown>()
}

void async function resultTypeChecks(client: Client<Endpoints>): Promise<void> {
  // `data` and `error` exclude each other, also once destructured: a failure's
  // error is never undefined (null without a body).
  const { data, error, status } = await client.result("GET /pets/{id}", { params: { id: 1 } })
  if (error === undefined) {
    // Raw XML is a Blob; `fetch` and `json()` give the JSON content alone.
    expectTypeOf(data).toEqualTypeOf<Schemas.Pet | Blob>()
  } else {
    expectTypeOf(data).toEqualTypeOf<undefined>()
    // Undeclared statuses may carry anything; `status` tells the declared ones apart.
    expectTypeOf(error).toEqualTypeOf<Schemas.Error | NonNullable<unknown> | null>()
    if (status === 404) expectTypeOf(error).toEqualTypeOf<Schemas.Error>()
  }
  if (status === 200) expectTypeOf(data).toEqualTypeOf<Schemas.Pet | Blob>()
  if (data !== undefined) expectTypeOf(error).toEqualTypeOf<undefined>()
  // A 304 has no body even under `default`: a truthiness check misses it.
  const listed = await client.result("GET /pets")
  if (listed.error) expectTypeOf(listed.error).toEqualTypeOf<Schemas.Error>()
  else expectTypeOf(listed.data).toEqualTypeOf<Schemas.Pet[] | undefined>()
  if (listed.error === undefined) expectTypeOf(listed.data).toEqualTypeOf<Schemas.Pet[]>()
  const deleted = await client.result("DELETE /pets/{id}", { params: { id: 1 } })
  if (deleted.error === undefined) expectTypeOf(deleted.data).toEqualTypeOf<undefined>()
  // A range includes the statuses that have no content.
  const searched = await client.result("GET /search", { query: { q: "x" } })
  if (searched.error === undefined) {
    expectTypeOf(searched.data).toEqualTypeOf<string | undefined>()
  }
  if (searched.status === 204) expectTypeOf(searched.data).toEqualTypeOf<undefined>()
  if (searched.status === 200) expectTypeOf(searched.data).toEqualTypeOf<string>()
  const checked = await client.result("GET /health")
  if (checked.error === undefined) expectTypeOf(checked.data).toEqualTypeOf<unknown>()
  const file = await client.result("GET /files/{names}", { params: { names: [] } })
  if (file.error === undefined) expectTypeOf(file.data).toEqualTypeOf<Blob>()
}

// Compile-time checks below are checked by `pnpm typecheck`; their bodies never run.
void async function forwardingChecks(client: Client<Endpoints>): Promise<void> {
  // A function that passes a call on names what it returns of a success by `EndpointData`.
  const dataOf = async <K extends ResultEndpoint<Endpoints>>(
    endpoint: K,
    ...args: EndpointArgs<Endpoints, K>
  ): Promise<EndpointData<Endpoints, K>> => {
    const { data: succeeded, error: failed } = await client.result(endpoint, ...args)
    if (failed !== undefined) throw new Error(`${endpoint} failed`)
    return succeeded
  }
  void dataOf("GET /pets")
  // @ts-expect-error path parameters are required through the wrapper, too
  void dataOf("GET /pets/{id}")
  const found = await dataOf("GET /pets/{id}", { params: { id: 1 } })
  expectTypeOf(found).toEqualTypeOf<Schemas.Pet | Blob>()
  // `2XX` takes in 204, which has no content.
  const results = await dataOf("GET /search", { query: { q: "x" } })
  expectTypeOf(results).toEqualTypeOf<string | undefined>()
  expectTypeOf<EndpointData<Endpoints, "DELETE /pets/{id}">>().toEqualTypeOf<undefined>()
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

  it("types a middleware where it is written, keeping what it carries", () => {
    const auth = defineMiddleware((request, next) => {
      expectTypeOf(request).toEqualTypeOf<Request>()
      return next(request)
    })
    expectTypeOf(auth).toEqualTypeOf<Middleware>()
    const named = defineMiddleware(Object.assign(auth, { label: "auth" }))
    expectTypeOf(named.label).toEqualTypeOf<string>()
    expect(named).toBe(auth)
    // @ts-expect-error a middleware resolves to a Response
    defineMiddleware((request: Request) => Promise.resolve(request))
    // @ts-expect-error the global fetch takes options, not next
    createClient(contract, { middleware: [fetch] })
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
      baseUrl: "https://api.test",
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

  it("checks result calls on a generated API with 1000 endpoints", async () => {
    const { code, diagnostics } = await generate({
      openapi: "3.1.0",
      info: { title: "Large API", version: "1" },
      paths: Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [
          `/items/${i}`,
          {
            get: {
              responses: {
                "200": {
                  description: "An item",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["id"],
                        properties: { id: { type: "integer", const: i } },
                      },
                    },
                  },
                },
              },
            },
          },
        ]),
      ),
    })
    expect(diagnostics).toStrictEqual([])
    expect(
      await typecheck(
        {
          "api.ts": code,
          "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
async function use() {
  const first = await api.result("GET /items/0")
  if (first.error === undefined) {
    first.data.id satisfies 0
    first.status satisfies 200
    first.response.json() satisfies Promise<{ id: 0 }>
    // @ts-expect-error another endpoint has different data
    first.data.id satisfies 999
  }
  const last = await api.result("GET /items/999")
  if (last.error === undefined) last.data.id satisfies 999
}
`,
        },
        {
          metrics: process.env.OPENAPI_SHAPE_TYPE_METRICS
            ? (summary) => console.info(`1000 generated endpoints\n${summary}`)
            : undefined,
        },
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
      await typecheck(
        {
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
        },
        {
          metrics: process.env.OPENAPI_SHAPE_TYPE_METRICS
            ? (summary) => console.info(`300 heterogeneous endpoints and wrappers\n${summary}`)
            : undefined,
        },
      ),
    ).toBe("")
  })

  // The methods keep their types when taken apart, as mocks and wrappers take them.
  expectTypeOf<Parameters<Client<Endpoints>["fetch"]>>().not.toBeNever()
  expectTypeOf<Awaited<ReturnType<Client<Endpoints>["result"]>>>().not.toBeAny()
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
          'const api = createClient(contract, { baseUrl: "https://api.test" })',
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
