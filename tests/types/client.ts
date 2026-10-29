// Compiler-only contracts. Included by tsconfig.json; never imported by the runtime suite.
import { expectTypeOf } from "vitest"
import type {
  Client,
  Endpoint,
  EndpointArgs,
  EndpointData,
  Middleware,
  MiddlewareContext,
  ResultEndpoint,
  TypedResponse,
} from "../../src/client"
import { createClient, defineMiddleware } from "../../src/client"
import type { Endpoints, Schemas } from "../fixtures/output/client-api"
import { contract } from "../fixtures/output/client-api"

// Compile-time checks below are checked by `pnpm typecheck`; their bodies never run.
void function inputChecks(client: Client<Endpoints>): void {
  const field =
    contract.endpoints["POST /token"].requestBody.content["application/x-www-form-urlencoded"]
      .encoding.grant_type
  // @ts-expect-error generated endpoint metadata remains deeply readonly
  field.repeat = false

  // @ts-expect-error path parameters are required
  void client.result("GET /pets/{id}")
  // @ts-expect-error parameter types are checked
  void client.result("GET /pets/{id}", { params: { id: "1" } })
  // @ts-expect-error a required query parameter
  void client.fetch("GET /search", { query: {} })
  // @ts-expect-error no request body on this operation
  void client.fetch("GET /pets", { body: {}, headers: { "content-type": "application/json" } })
  // @ts-expect-error the body is required
  void client.result("POST /pets")

  // @ts-expect-error body type is checked
  void client.result("POST /pets", {
    body: { name: 1 },
    headers: { "content-type": "application/json" },
  })
  // An optional body can be omitted.
  void client.result("PATCH /pets/{id}", { params: { id: 1 } })

  // @ts-expect-error the body is still checked
  void client.result("POST /charges", {
    body: { amount: "1" },
    headers: { "content-type": "application/x-www-form-urlencoded" },
  })
  // @ts-expect-error structured bodies require an explicit Content-Type
  void client.result("POST /upload", { body: { file: new Blob([]) } })
  void client.result("POST /upload", {
    body: { file: new Blob([]) },
    headers: { "content-type": "multipart/form-data" },
  })

  // @ts-expect-error the body must match the chosen media type
  void client.result("POST /upload", {
    body: { name: "x" },
    headers: { "content-type": "application/octet-stream" },
  })
  void client.result("POST /token", {
    body: { grant_type: "x" },
    headers: { "content-type": "application/x-www-form-urlencoded" },
  })
  // @ts-expect-error a query of undeclared parameters
  void client.result("GET /search", { query: { q: "x", size: 10 } })
  // @ts-expect-error declared headers in an object keep their types
  void client.result("GET /files/{names}", { params: { names: [] }, headers: { "X-Range": 1 } })
  // @ts-expect-error cookies are the runtime's (a browser sends its own)
  void client.result("GET /pets/{id}", { params: { id: 1 }, cookies: { session: "s" } })

  // An encoded form body is taken as it is.
  void client.result("POST /token", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  })

  // A sync iterable is not a body fetch sends.
  const iterable = [new Uint8Array()][Symbol.iterator]()

  // @ts-expect-error a sync iterable is sent as nothing useful
  void client.fetch("POST /upload", {
    body: iterable,
    headers: { "content-type": "application/octet-stream" },
  })
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
  void createClient(contract, { baseURL: new URL("https://api.test"), fetch: globalThis.fetch })
  // @ts-expect-error the option is named baseURL
  void createClient(contract, { baseUrl: "https://api.test" })
  // @ts-expect-error one signal would cancel every request; a call or the fetch option takes it
  void createClient(contract, { signal: AbortSignal.timeout(10_000) })
  void createClient<Endpoints>({
    version: 7,
    endpoints: {
      // @ts-expect-error a contract cannot have unrelated endpoint keys
      "GET /nope": { responses: { default: { content: { "*/*": {} } } } },
    },
  })
  // @ts-expect-error an older contract must be regenerated
  void createClient({ ...contract, version: 4 })
  // @ts-expect-error a newer contract must be regenerated with the installed package
  void createClient({ ...contract, version: 8 })
}

void function callBaseURLChecks(client: Client<Endpoints>): void {
  void client.fetch("GET /pets", { baseURL: "https://api.test/v2" })
  void client.result("GET /pets/{id}", {
    baseURL: new URL("https://uploads.test"),
    params: { id: 1 },
  })
  void client.stream("GET /events", { baseURL: "https://events.test" })
  // @ts-expect-error the per-call option is named baseURL
  void client.fetch("GET /pets", { baseUrl: "https://api.test" })
  // @ts-expect-error baseURL must be a string or URL
  void client.result("GET /pets", { baseURL: 42 })
  // @ts-expect-error baseURL does not make path parameters optional
  void client.fetch("GET /pets/{id}", { baseURL: "https://api.test" })
}

void function middlewareContextChecks(context: MiddlewareContext): void {
  // @ts-expect-error the call's endpoint is immutable
  context.endpoint = "GET /changed"
  // @ts-expect-error the call kind is immutable
  context.kind = "result"
}

// Compile-time checks below are checked by `pnpm typecheck`; their bodies never run.
void async function fetchTypeChecks(client: Client<Endpoints>): Promise<void> {
  const pet = await client.fetch("GET /pets/{id}", { params: { id: 1 } })
  if (pet.status === 200) expectTypeOf(await pet.json()).toEqualTypeOf<unknown>()
  if (pet.status === 404) expectTypeOf(await pet.json()).toEqualTypeOf<Schemas.Error>()
  // Undeclared error statuses have unknown bodies.
  if (pet.status === 500) expectTypeOf(await pet.json()).toEqualTypeOf<unknown>()
  expectTypeOf(pet).toExtend<Response>()
  if (pet.status === 0) expectTypeOf(await pet.json()).toEqualTypeOf<never>()

  // The explicit 200 has pets; `default` covers other statuses, including successes.
  const pets = await client.fetch("GET /pets")
  if (pets.ok) expectTypeOf(await pets.json()).toEqualTypeOf<Schemas.Pet[] | Schemas.Error>()
  if (!pets.ok) expectTypeOf(await pets.json()).toEqualTypeOf<Schemas.Error>()
  expectTypeOf<201>().toExtend<typeof pets.status>()

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
    // Raw XML is a Blob; result() retains both decoded representations.
    expectTypeOf(data).toEqualTypeOf<Schemas.Pet | Blob>()
  } else {
    expectTypeOf(data).toEqualTypeOf<undefined>()
    // Undeclared statuses may carry anything; `status` tells the declared ones apart.
    expectTypeOf(error).toEqualTypeOf<Schemas.Error>()
    if (status === 404) expectTypeOf(error).toEqualTypeOf<Schemas.Error>()
  }
  if (status === 200) expectTypeOf(data).toEqualTypeOf<Schemas.Pet | Blob>()
  if (data !== undefined) expectTypeOf(error).toEqualTypeOf<undefined>()
  // A 304 has no body even under `default`: a truthiness check misses it.
  const listed = await client.result("GET /pets")
  if (listed.error) expectTypeOf(listed.error).toEqualTypeOf<Schemas.Error>()
  else expectTypeOf(listed.data).toEqualTypeOf<Schemas.Pet[] | Schemas.Error | undefined>()
  if (listed.error === undefined)
    expectTypeOf(listed.data).toEqualTypeOf<Schemas.Pet[] | Schemas.Error | undefined>()
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
  expectTypeOf(checked).toEqualTypeOf<never>()
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

// The methods keep their types when taken apart, as mocks and wrappers take them.
expectTypeOf<Parameters<Client<Endpoints>["fetch"]>>().not.toBeNever()
expectTypeOf<Awaited<ReturnType<Client<Endpoints>["result"]>>>().not.toBeAny()
void function middlewareChecks() {
  const auth = defineMiddleware((request, next) => {
    expectTypeOf(request).toEqualTypeOf<Request>()
    return next(request)
  })
  expectTypeOf(auth).toExtend<Middleware>()
  const contextual = defineMiddleware((request, next, context) => {
    expectTypeOf(context).toEqualTypeOf<MiddlewareContext>()
    expectTypeOf(context.kind).toEqualTypeOf<"fetch" | "result" | "stream">()
    return next(request)
  })
  expectTypeOf(contextual).toEqualTypeOf<Middleware>()
  const named = defineMiddleware(Object.assign(auth, { label: "auth" }))
  expectTypeOf(named.label).toEqualTypeOf<string>()
  // @ts-expect-error a middleware resolves to a Response
  defineMiddleware((request: Request) => Promise.resolve(request))
  // @ts-expect-error the global fetch takes options, not next
  createClient(contract, { middleware: [fetch] })
}

// A default response also describes undeclared 2xx statuses: success alone
// cannot establish the explicit 200 payload, including when destructured.
interface DefaultResponseEndpoints {
  "GET /default": {
    responses: {
      200: { content: { "application/json": Array<{ name: string }> } }
      default: { content: { "application/json": { message?: string } } }
    }
  }
}
void async function defaultResponseChecks(client: Client<DefaultResponseEndpoints>) {
  const { data, error, status } = await client.result("GET /default")
  if (error === undefined) {
    // @ts-expect-error default successes need not contain a list
    data.map((pet: { name: string }) => pet.name)
  }
  if (status === 200) {
    expectTypeOf(data).toEqualTypeOf<Array<{ name: string }>>()
    expectTypeOf(error).toEqualTypeOf<undefined>()
    data.map((pet) => pet.name)
  }
  if (status === 201) {
    expectTypeOf(data).toEqualTypeOf<{ message?: string }>()
    expectTypeOf(error).toEqualTypeOf<undefined>()
  }
  if (status === 204) {
    expectTypeOf(data).toEqualTypeOf<undefined>()
  }
}
