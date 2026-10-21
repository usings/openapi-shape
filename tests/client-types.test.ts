import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, expectTypeOf, it } from "vitest"
import type {
  Client,
  Endpoint,
  EndpointArgs,
  EndpointData,
  Middleware,
  TypedResponse,
} from "../src/client"
import { createClient, defineMiddleware } from "../src/client"
import type { EndpointResult } from "../src/client/types"
import { generate } from "../src/index"
import type { Endpoints, Schemas } from "./__snapshots__/client-api"
import { contract } from "./__snapshots__/client-api"
import { expectPassesTsc, typecheck } from "./helpers/tsc"

describe("types", () => {
  it("keeps endpoint correlations through cross-file wrappers under stricter optional and index checks", async () => {
    expect(
      await typecheck(
        {
          "api.ts": await readFile(
            join(import.meta.dirname, "__snapshots__/client-api.ts"),
            "utf8",
          ),
          "data.ts": `
import { createClient } from "openapi-shape/client"
import type { Endpoint, EndpointArgs, EndpointData } from "openapi-shape/client"
import { contract, type Endpoints } from "./api"
const { result } = createClient(contract)
export async function data<K extends Endpoint<Endpoints>>(
  endpoint: K, ...args: EndpointArgs<Endpoints, K>
): Promise<EndpointData<Endpoints, K>> {
  const { data, error, status } = await result(endpoint, ...args)
  // @ts-expect-error an unchecked result may be a failure
  const unchecked: EndpointData<Endpoints, K> = data
  if (error !== undefined) throw new Error(String(status), { cause: error })
  return data
}
`,
          "use.ts": `
import { data } from "./data"
async function run() {
  const pet = await data("GET /pets/{id}", { params: { id: 1 } })
  if (!(pet instanceof Blob)) pet.id satisfies number
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

  it("treats 304 as empty across explicit, range, default, and undeclared responses", async () => {
    const responses = [
      '{ "304": Json<{ message: string }> }',
      '{ "3XX": Json<any> }',
      "{ default: Json<never> }",
      '{ "200": Json<string[]> }',
    ]
    const endpoints = responses.map((shape, i) => `"GET /${i}": { responses: ${shape} }`)
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
    await expectPassesTsc(`
import type { Client } from "openapi-shape/client"
type Json<T> = { content: { "application/json": T } }
declare const api: Client<{ ${endpoints.join("\n")} }>
async function use() { ${calls.join("\n")} }
`)
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

  it("keeps successes when a declared error body is never", async () => {
    const result = await typecheck({
      "use.ts": `
import type { Client } from "openapi-shape/client"
type Json<T> = { content: { "application/json": T } }
declare const api: Client<{
  "GET /never-error": { responses: { "200": Json<string>; "404": Json<never> } }
  "GET /never-default": { responses: { default: Json<never> } }
}>
async function use() {
  const found = await api.result("GET /never-error")
  if (found.error === undefined) {
    found.data.toUpperCase()
    found.status satisfies 200
    found.response.json() satisfies Promise<string>
  }
  const impossible = await api.result("GET /never-default")
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
      "use.ts": `
import type { Client } from "openapi-shape/client"
type Json<T> = { content: { "application/json": T } }
interface Endpoints {
  "GET /arrays": { responses: { "200": Json<string[]>; "206": Json<number[]> } }
  "GET /any": { responses: { "200": Json<string[]>; "206": Json<any> } }
}
declare const api: Client<Endpoints>
async function use() {
  const { data, error, status } = await api.result("GET /arrays")
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
  const mixed = await api.result("GET /any")
  if (mixed.status === 200) {
    mixed.data.map(value => value.toUpperCase()) satisfies string[]
    // @ts-expect-error a sibling's any must not erase this body's type
    mixed.data.push(1)
    // @ts-expect-error this body is not any
    const wrong: number = mixed.data
  }
}

`,
    })
    expect(result).toBe("")
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

  it("checks both generic wrapper forms and rejects unchecked results", async () => {
    const uses = ["destructured", "whole"].map((style) => {
      const binding = style === "whole" ? "result" : "{ data, error }"
      const field = style === "whole" ? "result." : ""
      return [
        `${style}.ts`,
        [
          'import type { Endpoint, EndpointArgs, EndpointData } from "openapi-shape/client"',
          'import { createClient } from "openapi-shape/client"',
          'import type { Endpoints } from "./api"',
          'import { contract } from "./api"',
          "const api = createClient(contract)",
          "type Data<K extends Endpoint<Endpoints>> = Promise<EndpointData<Endpoints, K>>",
          "type Args<K extends Endpoint<Endpoints>> = EndpointArgs<Endpoints, K>",
          "export async function data<K extends Endpoint<Endpoints>>(e: K, ...a: Args<K>): Data<K> {",
          `  const ${binding} = await api.result(e, ...a)`,
          "  // @ts-expect-error data of a failure, which is undefined",
          `  return ${field}data`,
          "}",
          "export async function error<K extends Endpoint<Endpoints>>(e: K, ...a: Args<K>): Data<K> {",
          `  const ${binding} = await api.result(e, ...a)`,
          "  // @ts-expect-error the error body",
          `  return ${field}error`,
          "}",
          "export async function checked<K extends Endpoint<Endpoints>>(e: K, ...a: Args<K>): Data<K> {",
          `  const ${binding} = await api.result(e, ...a)`,
          `  if (${field}error !== undefined) throw new Error('request failed')`,
          `  return ${field}data`,
          "}",
        ].join("\n"),
      ]
    })
    const result = await typecheck({
      "api.ts": await readFile(join(import.meta.dirname, "__snapshots__/client-api.ts"), "utf8"),
      ...Object.fromEntries(uses),
    })
    expect(result).toBe("")
  })

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
  // @ts-expect-error only declared media types
  void client.result("POST /token", { contentType: "application/json", body: { grant_type: "x" } })
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
  const unusual = createClient<{
    "GET /search": { body: { "application/json": { q: string } }; responses: object }
    "TRACE /debug": { responses: object }
    "connect /tunnel": { responses: object }
  }>({ version: 2, endpoints: {} })
  // @ts-expect-error fetch cannot send a body with GET
  void unusual.result("GET /search", { body: { q: "x" } })
  void unusual.result("GET /search")
  // @ts-expect-error fetch refuses TRACE
  void unusual.fetch("TRACE /debug")
  // @ts-expect-error and CONNECT, in any case
  void unusual.fetch("connect /tunnel")

  // Endpoints typed loosely by a record stay callable, also by a `string`.
  const loose = createClient<
    Record<
      string,
      {
        body?: { "application/json": object }
        responses: { "200": { content: { "application/json": number } } }
      }
    >
  >({ version: 2, endpoints: {} })
  void loose.result("GET /anything")
  void loose.fetch("POST /x")
  const anyEndpoint: string = "POST /x"
  void loose.result(anyEndpoint, { body: {} }).then(({ data, error }) => {
    if (error === undefined) expectTypeOf(data).toEqualTypeOf<number>()
  })
  void loose.result("HEAD /anything").then(({ data }) => {
    expectTypeOf(data).toEqualTypeOf<undefined>()
  })
  // The result alias of an open endpoint map retains the whole called key,
  // even though actually calling with a union is forbidden below.
  type OpenResult = EndpointResult<
    Record<string, { responses: { "200": { content: { "application/json": number } } } }>,
    "HEAD /anything" | "GET /anything"
  >
  expectTypeOf<Extract<OpenResult, { status: 200 }>["data"]>().toEqualTypeOf<number>()
  const looseEither = Math.random() > 0.5 ? "HEAD /anything" : "GET /anything"
  // @ts-expect-error a call still names one endpoint
  void loose.result(looseEither)

  // An index or template key stands for many endpoints: a call gets the results
  // of the endpoint it names, as an endpoint declared on its own does.
  interface Json<T> {
    responses: { "200": { content: { "application/json": T } } }
  }
  const patterned = createClient<{
    [endpoint: `${string} /files/${string}`]: Json<{ size: number }>
    [endpoint: string]: Json<unknown>
    "GET /a": Json<{ a: number }>
  }>({ version: 2, endpoints: {} })
  // A template's HEAD has no content, as HEAD has.
  void patterned.result("HEAD /files/x").then(({ data }) => {
    expectTypeOf(data).toEqualTypeOf<undefined>()
  })
  void patterned.result("GET /files/x").then(({ data, error }) => {
    if (error === undefined) expectTypeOf(data).toEqualTypeOf<{ size: number }>()
  })
  // A string index does not hide an endpoint declared beside it.
  void patterned.result("GET /a").then(({ data, error }) => {
    if (error === undefined) expectTypeOf(data).toEqualTypeOf<{ a: number }>()
  })
  expectTypeOf<
    EndpointData<typeof patterned extends Client<infer E> ? E : never, "GET /a">
  >().toEqualTypeOf<{ a: number }>()

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
  void createClient<Endpoints>({ version: 2, endpoints: { "GET /nope": {} } })
  // @ts-expect-error an older contract must be regenerated
  void createClient({ ...contract, version: 1 })
  // @ts-expect-error a newer contract must be regenerated with the installed package
  void createClient({ ...contract, version: 3 })
}

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
  const events = await client.result("GET /events")
  if (events.error === undefined) expectTypeOf(events.data).toEqualTypeOf<string>()
  expectTypeOf(events.response).toExtend<Response>()
}

void async function responseEdgeChecks(): Promise<void> {
  const edge = createClient<{
    "GET /download": { responses: { "200": { content: { "*/*": Blob } } } }
    "GET /report": { responses: { "200": { content: { "*/*": { rows: number } } } } }
    "GET /bytes": { responses: { "200": { content: { "application/json": Blob } } } }
    "HEAD /pets": { responses: { "200": { content: { "application/json": Schemas.Pet[] } } } }
    "DELETE /pets": {
      responses: { "204": { content: { "application/json": Schemas.Pet } }; "default": object }
    }
    "DELETE /pets/{id}": {
      params: { id: number }
      responses: { default: { content: { "application/json": Schemas.Error } } }
    }
    "head /x": { responses: { "200": { content: { "application/json": Schemas.Pet } } } }
  }>({ version: 2, endpoints: {} })
  // A wildcard's raw bytes may come labelled as anything; JSON is parsed, never a Blob.
  const download = await edge.result("GET /download")
  if (download.error === undefined) expectTypeOf(download.data).toEqualTypeOf<unknown>()
  const downloaded = await edge.fetch("GET /download")
  if (downloaded.ok) expectTypeOf(await downloaded.json()).toEqualTypeOf<unknown>()
  const report = await edge.result("GET /report")
  if (report.error === undefined)
    expectTypeOf(report.data).toEqualTypeOf<{ rows: number } | string | Blob>()
  const bytes = await edge.result("GET /bytes")
  if (bytes.error === undefined) expectTypeOf(bytes.data).toEqualTypeOf<unknown>()
  // HEAD and 204 responses carry nothing, whatever is declared.
  const head = await edge.result("HEAD /pets")
  if (head.error === undefined) expectTypeOf(head.data).toEqualTypeOf<undefined>()
  const headed = await edge.fetch("HEAD /pets")
  if (headed.ok) expectTypeOf(await headed.json()).toEqualTypeOf<never>()
  const removed = await edge.result("DELETE /pets")
  if (removed.error === undefined) expectTypeOf(removed.data).toEqualTypeOf<undefined>()
  // `default` alone covers success, too: its 204 has no content, and `json()` keeps the rest.
  const dropping = await edge.fetch("DELETE /pets/{id}", { params: { id: 1 } })
  if (dropping.ok) expectTypeOf(await dropping.json()).toEqualTypeOf<Schemas.Error>()
  const dropped = await edge.result("DELETE /pets/{id}", { params: { id: 1 } })
  if (dropped.status === 204) expectTypeOf(dropped.data).toEqualTypeOf<undefined>()
  if (dropped.status === 200) expectTypeOf(dropped.data).toEqualTypeOf<Schemas.Error>()
  // A method is compared as fetch sends it, uppercase.
  const lower = await edge.result("head /x")
  if (lower.error === undefined) expectTypeOf(lower.data).toEqualTypeOf<undefined>()
}

void async function forwardingChecks(client: Client<Endpoints>): Promise<void> {
  // A function that passes a call on names what it returns of a success by `EndpointData`.
  const dataOf = async <K extends Endpoint<Endpoints>>(
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

// The methods keep their types when taken apart, as mocks and wrappers take them.
expectTypeOf<Parameters<Client<Endpoints>["fetch"]>>().not.toBeNever()
expectTypeOf<Awaited<ReturnType<Client<Endpoints>["result"]>>>().not.toBeAny()

it("checks 300 heterogeneous endpoints directly and through both generic wrapper forms", async () => {
  const ids = Array.from({ length: 300 }, (_, i) => i)
  const endpoints = ids.map(
    (i) => `
  "GET /resource-${i}": {
    params: { id: number }
    responses: {
      "200": { content: { "application/json": { kind: "resource-${i}"; name: string; detail: { value: ${i}; tags: string[] } }[] } }
      "206": { content: { "application/json": number[] } }
      "404": { content: { "application/json": { message: string; code: ${i} } } }
    }
  }`,
  )
  const calls = ids.map(
    (i) => `
async function call${i}() {
  const r${i} = await client.result("GET /resource-${i}", { params: { id: 1 } })
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
async function checked_${style}<K extends Endpoint<Endpoints>>(
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
        "use.ts": `
import type { Client, Endpoint, EndpointArgs, EndpointData } from "openapi-shape/client"
interface Endpoints { ${endpoints.join("\n")} }
declare const client: Client<Endpoints>
${calls.join("\n")}
${wrappers.join("\n")}
async function wrappedCalls() {
  const first = await checked_whole("GET /resource-0", { params: { id: 1 } })
  first satisfies Endpoints["GET /resource-0"]["responses"]["200"]["content"]["application/json"] | number[]
  const last = await checked_destructured("GET /resource-299", { params: { id: 1 } })
  last satisfies Endpoints["GET /resource-299"]["responses"]["200"]["content"]["application/json"] | number[]
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
