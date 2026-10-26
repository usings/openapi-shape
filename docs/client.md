# Send requests

`openapi-shape/client` uses a generated `contract` to serialize requests and type responses. It uses native Fetch and Web Streams, has no runtime dependencies, and does not validate payloads against schemas.

## Create a client

Generate `api.ts` first using the [generation guide](./generation.md). The examples here use the [Petstore description](../docs/examples/petstore.yaml); replace the example address with your API's address.

```ts
import { createClient } from "openapi-shape/client"
import { contract } from "./api"

const api = createClient(contract, { baseURL: "https://api.example.com/v1" })
```

| Option         | Meaning                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `baseURL`      | String or `URL` prefix for endpoint paths, without a query or fragment. Browsers may use relative URLs; Node needs an absolute URL. |
| `headers`      | Default headers; call headers take precedence.                                                                                      |
| `middleware`   | Request wrappers; the first is outermost. See [middleware](#middleware).                                                            |
| `fetch`        | A `(request: Request) => Promise<Response>` transport. Defaults to global Fetch. Use this for transport test doubles.               |
| Other defaults | `RequestInit` fields except `method`, `body`, and `signal`; calls override them.                                                    |

## Supply request inputs

An endpoint key is `"METHOD /path"`, with the path template unchanged. Each call accepts operation inputs plus `RequestInit` options such as `signal`, `cache`, and `credentials`. The second argument is required when path parameters, query inputs, or a body are required.

```ts
const result = await api.result("GET /pets/{petId}", {
  params: { petId: 1 },
  signal: AbortSignal.timeout(10_000),
})
console.log(result.status)
```

| Field         | Meaning                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `params`      | Path parameter values; required variables must be own properties.             |
| `query`       | Query parameters, or the complete OpenAPI 3.2 `querystring` value.            |
| `headers`     | Typed header values, `Headers`, or entries; extra headers are allowed.        |
| `body`        | Structured or ready-made body. Not accepted for `GET` or `HEAD`.              |
| `contentType` | A declared request media type; required when no default can be selected.      |
| `baseURL`     | Replace the client's URL prefix for this call. `undefined` keeps the default. |

Endpoint paths append to `baseURL` after trailing slashes are removed. A per-call override does not change other calls; default headers, credentials, and middleware still apply. Unknown endpoints fail before transport. `CONNECT`, `TRACE`, and `TRACK` are excluded.

`query` is required when any ordinary query parameter is required, or when the whole `querystring` is required even if its properties are optional. Headers are optional per call because defaults or middleware can supply them. Browsers manage cookies; other runtimes can supply a `cookie` header.

### Send a body

```ts
await api.result("POST /pets", { body: { name: "Milo" } })

const file = new Blob(["example"], { type: "text/plain" })
await api
  .fetch("POST /upload", {
    baseURL: "https://uploads.example.com",
    body: { file, name: "notes" },
  })
  .then((response) => response.body?.cancel())
```

The client encodes JSON, URL-encoded forms, and `multipart/form-data`; text takes strings. It selects the sole `application/json` declaration, including parameters, or otherwise the sole declared media type. If neither is unique, supply `contentType`.

`Blob`, buffers, `FormData`, `URLSearchParams`, Web streams, and byte async iterables are ready bodies. Streams use half duplex. Other media types and sequential request bodies need encoded data. See [serialization](./serialization.md) for content types, multipart parts, styles, and escaping.

## Handle a decoded result

`api.result()` reads a complete non-streaming response and resolves to `{ data, error, status, response }`:

```ts
const {
  data: pet,
  error,
  status,
} = await api.result("GET /pets/{petId}", {
  params: { petId: 1 },
})
if (error === undefined) {
  console.log(pet.name)
} else if (status === 404) {
  console.warn(error.message)
} else {
  console.error(status, error)
}
```

All 2xx statuses are runtime successes. Success has `error: undefined`; failure has `data: undefined` and an error body, or `null` when empty. Use `error === undefined`, not truthiness: an error can be `null`, `false`, or an empty string. The top-level `status` narrows the corresponding data and error, including after destructuring; `response.status` does not narrow its sibling fields.

HTTP error statuses resolve normally. Construction, transport, middleware, and decoding errors reject. For JSON, empty or malformed content rejects with the native parsing error.

The call signal remains active while `result()` reads the body, including responses supplied directly by middleware or a custom transport. Abort rejects with `signal.reason` and cancels the body without waiting for its cleanup to finish.

| Actual response           | Decoding                                 |
| ------------------------- | ---------------------------------------- |
| JSON (`…/json`, `…+json`) | `response.json()`                        |
| Other `text/*`            | String                                   |
| `HEAD`, 204, 205, 304     | `undefined`; a supplied body is canceled |
| No `Content-Type`         | `undefined` if empty, otherwise `Blob`   |
| Other media               | `Blob`                                   |

Content type selection follows Fetch MIME extraction, including multi-value headers. Multiple declared media produce a union of their decoded types; narrow the value before using schema properties. `response` remains useful for headers, but its body is already read or canceled. Use `fetch()` when you need body ownership.

### Status typing

Exact response codes take precedence over ranges such as `2XX`. If any 2xx response is declared, those declarations define the typed successes. Otherwise `default` also covers undeclared successes. Without `default`, undeclared errors, and successes when none were declared, have unknown bodies.

`HEAD` and statuses 204, 205, and 304 have no content regardless of the description; a 304 result has `error: null`. Types describe HTTP statuses 200–599 according to those rules, not unexpected runtime values such as opaque browser status `0`.

## Own the response with Fetch

`api.fetch()` accepts any callable endpoint, including streaming endpoints. It returns a native `Response` whose `ok` and `status` narrow the type returned by `json()`:

```ts
const response = await api.fetch("GET /pets/{petId}", { params: { petId: 1 } })
if (response.ok) {
  console.log((await response.json()).name)
} else if (response.status === 404) {
  console.warn((await response.json()).message)
} else {
  console.error(response.status, await response.text())
}
```

Read or cancel unused bodies. Other `Response` properties and methods keep native behavior. JSON-compatible wildcard declarations use their JSON projection; binary alternatives are `unknown`. When no content is declared, `json()` returns `Promise<never>` because empty-body parsing rejects.

For SSE and JSON record consumption, use the [streaming guide](./streaming.md).

## Middleware

Middleware wraps all three methods and every managed SSE connection. Supply refreshed credentials here; static headers can live in client defaults. This example assumes `getToken(): Promise<string>` from your authentication code:

```ts
import { createClient, defineMiddleware } from "openapi-shape/client"
import { contract } from "./api"

const auth = defineMiddleware(async (request, next) => {
  const authorized = new Request(request)
  authorized.headers.set("authorization", `Bearer ${await getToken()}`)
  return next(authorized)
})
const logger = defineMiddleware(async (request, next, context) => {
  const response = await next(request)
  console.log(context.kind, context.endpoint, response.status)
  return response
})
const api = createClient(contract, {
  baseURL: "https://api.example.com/v1",
  middleware: [logger, auth],
})
```

The first wrapper is outermost. Each receives `(request, next, context)` and returns a promise of a `Response`; `defineMiddleware` supplies types and returns the same function. A wrapper can replace the request, return a response directly, or call `next` repeatedly through the remaining chain. `context.endpoint` keeps the original template and `context.kind` is `"fetch"`, `"result"`, or `"stream"`, even after rewrites or reconnections.

Result decoding and stream parsing happen after the chain returns, so middleware observes HTTP responses rather than the completion of body processing. An unchanged transport rejection can trigger [SSE reconnection](./streaming.md#sse-reconnection); a middleware's own thrown error terminates the subscription.

### Signals and body ownership

Pass the call signal per request; preserve `request.signal` when replacing a request. A per-attempt timeout can combine it with a deadline:

```ts
import { defineMiddleware } from "openapi-shape/client"

export const timeout = defineMiddleware((request, next) => {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  return next(new Request(request, { signal }))
})
```

The timeout includes response-body reading, so allow the intended lifetime of a long-lived connection. The original call signal still governs pending dispatch even if middleware replaces the outgoing signal; abort prevents retained `next` functions from sending again.

Requests pass by reference. Use `new Request(request, init)` to isolate changes; its constructor takes over the original body. Bodies are single-use: clone before the first attempt if retrying, and consume or cancel discarded responses before waiting for another attempt.

Each `next()` transfers its delivered response to the awaiting middleware. That middleware owns any response it discards, including on an error, plus its reader locks, clones, and tee branches. The client cleans up responses that cannot cross a pending boundary after cancellation; it does not revoke already delivered responses. Avoid reading clones of indefinite streams to completion or leaving tee branches unread.

## Preserve types in wrappers

Use the exported helpers rather than reconstructing operation types:

```ts
import {
  createClient,
  type EndpointArgs,
  type EndpointData,
  type ResultEndpoint,
} from "openapi-shape/client"
import { contract, type Endpoints } from "./api"

const { result } = createClient(contract, { baseURL: "https://api.example.com/v1" })
export async function data<K extends ResultEndpoint<Endpoints>>(
  endpoint: K,
  ...args: EndpointArgs<Endpoints, K>
): Promise<EndpointData<Endpoints, K>> {
  const { data, error, status } = await result(endpoint, ...args)
  if (error !== undefined) throw new Error(`HTTP ${status}`, { cause: error })
  return data
}
const pet = await data("GET /pets/{petId}", { params: { petId: 1 } })
console.log(pet.name)
```

| API      | Endpoint keys               | Arguments                     | Value                                          |
| -------- | --------------------------- | ----------------------------- | ---------------------------------------------- |
| `fetch`  | `Endpoint<Endpoints>`       | `EndpointArgs<Endpoints, K>`  | `TypedResponse`, narrowed by status            |
| `result` | `ResultEndpoint<Endpoints>` | `EndpointArgs<Endpoints, K>`  | `EndpointData<Endpoints, K>` for success data  |
| `stream` | `StreamEndpoint<Endpoints>` | `StreamArgs<Endpoints, K, M>` | `EndpointStreamItem<Endpoints, K, M>` per item |

A call names one endpoint, not a union of keys. Stream wrappers should preserve `M extends StreamMedia<Endpoints, K>` so `accept` narrows the item. `EndpointMessage` is SSE-specific; `StreamOptions` and `StreamRetryOptions` describe stream settings. `Middleware`, `MiddlewareContext`, and `Fetcher` type request wrappers and transports.
