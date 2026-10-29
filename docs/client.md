# Send requests

`openapi-shape/client` uses a generated `contract` to serialize requests and type responses. It uses native Fetch and Web Streams, has no runtime dependencies, and does not validate payloads against schemas.

## Create a client

Generate `api.ts` first using the [generation guide](./generation.md). The examples here use the [Petstore description](../docs/examples/petstore.yaml); replace the example address with your API's address.

<!-- example: standalone -->

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

<!-- example: client -->

```ts
const result = await api.result("GET /pets/{petId}", {
  params: { petId: 1 },
  signal: AbortSignal.timeout(10_000),
})
console.log(result.status)
```

| Field                     | Meaning                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `params`                  | Path parameter values; required variables must be own properties.              |
| `query`                   | Query parameters, or the complete OpenAPI 3.2 `querystring` value.             |
| `headers`                 | Typed header values, `Headers`, or entries; extra headers are allowed.         |
| `body`                    | Structured or ready-made body. Not accepted for `GET` or `HEAD`.               |
| `headers["content-type"]` | Explicit media selection for a structured body; checked against its body type. |
| `baseURL`                 | Replace the client's URL prefix for this call. `undefined` keeps the default.  |

Endpoint paths append to `baseURL` after trailing slashes are removed. A per-call override does not change other calls; default headers, credentials, and middleware still apply. Unknown operations fail before transport. `CONNECT`, `TRACE`, and `TRACK` are excluded.

`query` is required when any ordinary query parameter is required, or when the whole `querystring` is required even if its properties are optional. Ordinary declared headers are optional per call because defaults or middleware can supply them; structured-body media selection can come from literal client defaults, explicit call headers, or the JSON fallback. Opaque default headers require explicit media for structured bodies. Browsers manage cookies; other runtimes can supply a `cookie` header.

### Send a body

<!-- example: client -->

```ts
const { data, error, status } = await api.result("POST /pets", {
  body: { name: "Milo" },
})
if (error !== undefined) throw new Error(`HTTP ${status}`, { cause: error })
console.log(data.name) // This operation declares a 201 response.

const file = new Blob(["example"], { type: "text/plain" })
await api
  .fetch("POST /upload", {
    baseURL: "https://uploads.example.com",
    body: { file, name: "notes" },
    headers: { "content-type": "multipart/form-data" },
  })
  .then((response) => response.body?.cancel())
```

The client encodes JSON, URL-encoded forms, and `multipart/form-data`; other text takes strings. Other media and sequential request formats need encoded data. See [serialization](./serialization.md) for wire formats, multipart parts, styles, and escaping.

`Blob`, buffers, `FormData`, `URLSearchParams`, `ReadableStream<Uint8Array>`, and byte async iterables are ready bodies. Streaming uploads use half duplex. `FormData` and `URLSearchParams` supply their own Content-Type.

## Select media

Header record names are case-insensitive. For each header, call values override client defaults.

For structured bodies, the effective Content-Type selects a declaration in `requestBody.content` and its encoding rules. If no header supplies it, the client falls back to `application/json` when the contract permits JSON. A known literal default or call header keeps the body associated with its schema; opaque defaults require an explicit call header for structured input. Content-Type type/subtype casing and additional parameters are accepted when the declaration is unambiguous. Parameterized declarations require an exact match where static parameter precedence cannot be established. The [serialization rules](./serialization.md#bodies-and-content-types) describe runtime matching and ready bodies.

Accept expresses response preferences. `fetch()` and `result()` allow lists and ranges without narrowing their response types; [stream selection](./streaming.md#select-a-representation) can narrow parsed items. `Headers` and entry lists are usable for native bodies and dynamic response negotiation when no static media association is needed.

## Handle a decoded result

`api.result()` reads a complete non-streaming response and resolves to `{ data, error, status, response }`:

<!-- example: client -->

```ts
const { data, error, status } = await api.result("GET /pets/{petId}", {
  params: { petId: 1 },
})
if (error === undefined) {
  console.log(data.name)
} else if (status === 404) {
  console.warn(error.message)
} else {
  console.error(status, error)
}
```

Declared 2xx responses have `error: undefined`; other declared statuses have `data: undefined` and an error body, or `null` when empty. Check `error === undefined`: error bodies can be falsy. Use the top-level `status` to select a particular response schema, including after destructuring; `response.status` does not narrow sibling fields. See [type narrowing](./types.md#narrow-successful-responses) for multiple successful representations.

### Decode the body

| Actual response                                               | Decoding                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| JSON (`…/json`, `…+json`)                                     | `response.json()`                                                    |
| Other `text/*`                                                | String                                                               |
| `HEAD`, 204, 205, 304, or a declared response without content | `undefined`; a supplied body is canceled for HTTP bodyless responses |
| No Content-Type with declared wildcard content                | `Blob`, including zero bytes                                         |
| Other media                                                   | `Blob`                                                               |

Content-Type selection follows Fetch MIME extraction, including multi-value headers. Multiple complete media at one status retain a union of decoded types.

### Handle rejected calls

Declared HTTP error statuses resolve normally. Construction, transport, middleware, and decoding failures reject; empty or malformed JSON rejects with the native parsing error.

`result()` checks the actual status and Content-Type against the contract. An undeclared status, media mismatch, unexpected body on a declaration without content, or supported streaming representation raises `ContractResponseError` after canceling the body; the error's `response` retains status and headers. An endpoint offering both complete and streaming media can use `result()` for the complete representation. HTTP bodyless responses are handled before media matching. These checks do not validate payloads against JSON schemas.

### Response ownership and cancellation

`result()` reads or cancels the body. Its `response` exposes metadata; use `fetch()` to own body consumption or inspect responses outside the contract.

The call signal remains active during body reading, including responses supplied by middleware or custom transports. Abort rejects with `signal.reason` and cancels the body without waiting for cleanup to finish.

### Status typing

Exact response codes take precedence over ranges such as `2XX`, then `default`. The fallback covers any remaining status, including successes. `HEAD` and statuses 204, 205, and 304 have no content regardless of schema; a 304 result has `error: null`.

`fetch()` includes undeclared responses with conservatively typed bodies and native opaque status `0`, whose empty body cannot be parsed as JSON. `result()` returns only declared representations.

## Own the response with Fetch

`api.fetch()` accepts any callable endpoint, including streaming endpoints. It returns a native `Response` whose `ok` and `status` narrow the type returned by `json()`:

<!-- example: client -->

```ts
const response = await api.fetch("GET /pets/{petId}", { params: { petId: 1 } })

if (response.status === 200) {
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

<!-- example: auth -->

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

<!-- example: standalone -->

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

See [type inference and wrappers](./types.md) for reusable generic calls and client default media types.
