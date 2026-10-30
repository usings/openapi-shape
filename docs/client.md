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

## Choose a response API

| Method     | Use it when                                                                    | Response body owner                              |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `result()` | You want decoded data and declared HTTP error bodies.                          | The client reads or cancels it.                  |
| `fetch()`  | You need the native response, including undeclared statuses or encoded bodies. | You read or cancel it.                           |
| `stream()` | You want SSE messages or JSON records as they arrive.                          | The subscription reads it; cancel when finished. |

All three share request inputs, defaults and middleware. Streaming behavior is covered in the [streaming guide](./streaming.md).

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

`query` is required when any ordinary query parameter is required, or when the whole `querystring` is required even if its properties are optional. Ordinary declared headers are optional per call because defaults or middleware can supply them. Browsers manage cookies; other runtimes can supply a `cookie` header.

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

Content-Type selects how a structured body is encoded. Call headers override client defaults; without either, structured bodies use `application/json`, which must match a declared request representation. Set an explicit header when sending a form or another representation. [Serialization](./serialization.md#bodies-and-content-types) defines matching, ready bodies and wire formats; [configured type inference](./types.md#preserve-configured-defaults) explains literal and dynamic headers.

Accept expresses response preferences. `fetch()` and `result()` allow lists and ranges without narrowing their response types. For `stream()`, [representation selection](./streaming.md#select-a-representation) determines item types and whether SSE reconnection is available.

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

| Accepted response                              | Decoding                                   |
| ---------------------------------------------- | ------------------------------------------ |
| JSON (`…/json`, `…+json`)                      | `response.json()`                          |
| Other `text/*`                                 | String                                     |
| `HEAD`, 204, 205, 304                          | `undefined`; any supplied body is canceled |
| No declared content and no body                | `undefined`                                |
| No Content-Type with declared wildcard content | `Blob`, including zero bytes               |
| Other media                                    | `Blob`                                     |

A declaration without `content` does not allow an unexpected body on other statuses; that is a [contract failure](#handle-rejected-calls). Content-Type selection follows Fetch MIME extraction, including multi-value headers. Multiple complete media at one status retain a union of decoded types.

## Own the response with Fetch

`api.fetch()` accepts any callable endpoint, including streaming endpoints. It returns a native `Response` whose `ok` and `status` narrow the type returned by `json()`. Statuses offering non-JSON media or media ranges keep `json()` typed as `unknown`, because parsing those bytes need not produce the declared JSON schema:

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

Read or cancel unused bodies. Other `Response` properties and methods keep native behavior. When no content is declared, `json()` returns `Promise<never>` because empty-body parsing rejects.

For SSE and JSON record consumption, use the [streaming guide](./streaming.md).

## Status typing

Exact response codes take precedence over ranges such as `2XX`, then `default`. The fallback covers any remaining status, including successes. `HEAD` and statuses 204, 205, and 304 have no content regardless of schema; a 304 result has `error: null`.

`fetch()` includes undeclared responses with conservatively typed bodies and native opaque status `0`, whose empty body cannot be parsed as JSON. `result()` returns only declared representations.

## Response headers

`fetch()` and `result().response` retain native `Headers`. The `get()` and `has()` methods suggest lowercase header names from the current status declaration; narrow `response.status` or the result's top-level `status` to select that declaration. Other names, casing and dynamic strings are accepted.

<!-- example: client -->

```ts
const response = await api.fetch("GET /pets")
if (response.status === 200) {
  const next = response.headers.get("x-next") // Declared name suggested; string | null.
  console.log(next)
}
await response.body?.cancel()
```

Header values remain `string | null`, even for required or numeric schemas: no parsing, validation or presence check is performed. Browser visibility rules can also hide response headers. `HEAD`, 204, 205 and 304 keep header hints despite having no response content. `ResponseHeaders<Name>` is available for explicit annotations; normal calls infer it automatically.

## Handle rejected calls

HTTP responses and failures to complete a call are handled differently:

| API        | Non-successful HTTP status                                                                           | Other failures                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `fetch()`  | Resolves to the native response, declared or not.                                                    | Request construction, transport and middleware failures reject.                           |
| `result()` | Declared statuses resolve with an `error` body or `null`.                                            | Contract checks, body reading and decoding failures reject.                               |
| `stream()` | Errors consumption unless the selected SSE reconnection policy retries it. HTTP 204 closes normally. | Construction, validation, transport and parsing failures are observed during consumption. |

`stream()` is lazy: creating it does not send a request. See [SSE reconnection](./streaming.md#sse-reconnection) for retryable outcomes. Empty or malformed JSON decoded by `result()` rejects with the native parsing error.

`result()` checks the actual status and Content-Type against the contract. An undeclared status, media mismatch, unexpected body on a declaration without content, or supported streaming representation raises `ClientError` after canceling the body; the error's `details.response` retains status and headers. An endpoint offering both complete and streaming media can use `result()` for the complete representation. HTTP bodyless responses are handled before media matching. These checks do not validate payloads against JSON schemas.

Library-owned response and stream failures use `ClientError`. Its `code` discriminates `details`; native errors, middleware failures and cancellation reasons pass through unchanged.

| Code                    | Diagnostic details                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `HTTP_ERROR`            | `response`: a non-successful stream response                                                                  |
| `UNDECLARED_STATUS`     | `response`: a status outside the operation's declarations                                                     |
| `UNEXPECTED_MEDIA_TYPE` | `response`, `expected` media declarations, and `actual` effective Content-Type (`undefined` when unavailable) |
| `INVALID_RESPONSE_BODY` | `response`: an unexpected, missing, consumed or locked body                                                   |
| `INVALID_STREAM_RECORD` | `line`: one-based JSONL/NDJSON record line; the original failure is in `error.cause`                          |
| `MESSAGE_TOO_LARGE`     | `maxMessageBytes` and `receivedBytes`                                                                         |

<!-- example: client -->

```ts
import { ClientError } from "openapi-shape/client"

try {
  await api.result("GET /pets")
} catch (error) {
  if (!(error instanceof ClientError)) throw error
  switch (error.code) {
    case "UNEXPECTED_MEDIA_TYPE":
      console.error(error.details.expected, error.details.actual)
      break
    case "UNDECLARED_STATUS":
      console.error(error.details.response.status)
      break
    default:
      throw error
  }
}
```

Branch on `code`, not message wording.

## Response ownership and cancellation

`result()` reads or cancels the body. Its `response` exposes metadata; use `fetch()` to own body consumption or inspect responses outside the contract.

The call signal remains active during body reading, including responses supplied by middleware or custom transports. Abort rejects with `signal.reason` and cancels the body without waiting for cleanup to finish.

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
