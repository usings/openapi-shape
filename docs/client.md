# Client

`openapi-shape/client` provides three ways to consume an API response: decoded results, typed Web Streams, and a typed `Response`. Each uses [the generated contract](./output.md#the-runtime-contract) for API types and serialization settings, with shared request defaults and middleware. The client has no dependencies and runs on standard Fetch API globals.

The client serializes requests and decodes responses; it does not validate their schemas. If the schema says `{ id: number }` but the server returns `{"id":"wrong"}`, the JSON is still returned with the declared static type. Validate data separately when needed. See [type guarantees and limits](./openapi.md#support-boundaries).

```ts
import { createClient } from "openapi-shape/client"
import { contract } from "./api"

const api = createClient(contract, { baseUrl: "https://api.example.com/v1" })

const {
  data: pet,
  error,
  status,
} = await api.result("GET /pets/{petId}", {
  params: { petId: 1 },
})
if (error === undefined) {
  console.log(pet.name) // pet: Schemas.Pet
} else if (status === 404) {
  console.warn(error.message) // error: Schemas.Error
} else {
  console.error(status, error)
}
```

## Creating a client

`createClient(contract, options?)` infers the API types from the generated `contract`. Its options configure the base URL, request defaults, and how requests are sent:

| Option           | Description                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`        | The prefix for endpoint paths, such as `https://api.example.com/v1`. Queries and fragments are not allowed. Omit it for relative URLs in a browser; Node requires an absolute URL.                                |
| `middleware`     | Functions that wrap each request, with the first running outermost. See [Middleware](#middleware).                                                                                                                |
| `fetch`          | The transport function: takes a `Request` and resolves to a `Response` after the middleware runs. Defaults to global `fetch`; replace it with a test double or custom transport.                                  |
| Request defaults | `RequestInit` fields other than `method`, `body`, and `signal`, including `headers`, `credentials`, and `cache`. Each call overrides these defaults; headers are merged with the call's values taking precedence. |

## Calls

Choose a method according to the response you need:

| Method                        | Endpoints               | Return value                                                                                  |
| ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `api.result(endpoint, init?)` | Non-streaming endpoints | A promise of `{ data, error, status, response }` after reading and decoding the body.         |
| `api.stream(endpoint, init?)` | Streaming endpoints     | A native `ReadableStream` of typed SSE messages or JSON line records, returned synchronously. |
| `api.fetch(endpoint, init?)`  | All callable endpoints  | A promise of the `Response`, typed by status, with its body unread.                           |

A streaming endpoint has an effective successful response explicitly declaring `text/event-stream`, `application/jsonl`, or `application/x-ndjson`, ignoring media type case and parameters. The [status rules](#status-handling) determine which response declaration applies; `HEAD` and bodyless statuses do not qualify. Wildcards such as `text/*` and media declared only for an error do not classify an endpoint as streaming. A declaration qualifies even when its schema allows no values.

`result` and `stream` accept separate endpoint sets, checked by TypeScript and at runtime. An endpoint offering both JSON and a supported stream belongs to `stream`; use `fetch` to select and read its JSON representation. `fetch` works with every callable endpoint, including downloads and unsupported sequence formats such as `application/json-seq` and `…+json-seq`.

All calls take the operation's typed inputs and per-call request options. `stream` also takes a media selection and SSE retry settings. `result` and `fetch` reject their promises on request construction, transport, or middleware failures; they resolve for every HTTP status. `result` also rejects on decoding errors. Stream construction is lazy: request errors surface through stream consumption, and its [connection policy](#reconnection) determines which failures retry.

## Requests

### What a call takes

The second argument combines request options such as `signal`, `cache`, and `keepalive` with the operation's typed inputs below. The endpoint determines `method`; the client types `headers` and `body` from the operation.

This argument is required when `params`, `query`, or `body` is required. Declared headers are optional per call because defaults or middleware may provide them. Unknown endpoints produce compile errors and are rejected at runtime before transport. Methods forbidden by Fetch (`CONNECT`, `TRACE`, `TRACK`) are excluded from the generated endpoint map.

| Field         | Rule                                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params`      | Required when the path has parameters; values must be own properties of `params`, not inherited.                                                                                                                                                                |
| `query`       | Required when any query parameter is required, or when the whole `querystring` parameter is required, even if all of its properties are optional.                                                                                                               |
| `headers`     | Optional. Object values use the declared parameter types and styles; additional headers are allowed. A `Headers` instance or entries are passed through. Call headers override defaults. `FormData` and `URLSearchParams` always supply their own content type. |
| `body`        | Required when the request body is required. Not taken with `GET` or `HEAD`, which `fetch` cannot send a body with.                                                                                                                                              |
| `contentType` | The declared media type of `body`. Optional when there is a default: the sole `application/json` entry, including media type parameters, or otherwise the sole declared media type.                                                                             |

Client calls have no cookie input. Browsers manage cookies; other runtimes can send a `cookie` header.

### Request bodies

The media type determines which body values the client accepts and how it sends them:

| Media type                                       | `body`                                  | Sent as                                                                                    |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| JSON: `…/json`, `…+json`, `*/*`, `application/*` | The schema's type                       | JSON                                                                                       |
| `application/x-www-form-urlencoded`              | The schema's type, or an encoded string | Fields serialized as their Encoding Objects say (`deepObject` as `metadata[key]=value`, …) |
| `multipart/form-data`                            | The schema's type                       | `FormData`: schema-derived or explicit part types; arrays repeat their parts               |
| Other `text/*`, except `text/event-stream`       | A string                                | As given                                                                                   |
| Anything else                                    | A `Blob`, buffer, stream, or string     | As given                                                                                   |

Schema strings remain strings in JSON, parameters, and text-encoded fields. Multipart variants use `Blob` for file parts and arrays of files; object parts, nested arrays, and styled fields use their textual projection. The client does not convert bytes to base64.

Ready bodies such as `Blob`, `FormData`, `URLSearchParams`, and buffers use their own bytes. `FormData` and `URLSearchParams` set their own content type. `fetch` and `result` also accept Web and Node.js streams, sent with half duplex.

Other ready bodies use the selected media type or the generated [`contentType` default](./output.md#the-runtime-contract), including `application/json` and its parameters. Without a concrete label, a `Blob` uses its own type. Wildcards such as `image/*` do not label a body.

Only `multipart/form-data` is encoded automatically. For other multipart types, provide an encoded body with its content type and boundary.

On first demand, `stream` builds the request and buffers its encoded body once. SSE reconnections reuse those bytes, including a stable multipart boundary. It accepts JSON, text, forms, blobs, and buffers, and rejects `ReadableStream` and async iterable request bodies. Request fields and body inputs are fixed for that subscription after first demand. A retried POST can repeat an operation. The client provides no exactly-once guarantee; use a server protocol that supports resumption or deduplication where needed. JSON line streams make one managed attempt and never replay automatically.

### Form field defaults

URL-encoded and multipart forms use the encodings for the selected media type, including its parameters. Without an explicit style, named fields use these defaults:

| Field type                     | Default content type                          |
| ------------------------------ | --------------------------------------------- |
| Object                         | `application/json`                            |
| Primitive                      | `text/plain`                                  |
| Raw bytes, or no explicit type | `application/octet-stream`                    |
| Array                          | The item type's default, applied to each item |

For example, `meta: { id: 1 }` becomes `meta=%7B%22id%22%3A1%7D` in a URL-encoded form. Arrays of objects repeat the field with one JSON value per item. Form `querystring` parameters follow these rules; ordinary query parameters use parameter styles.

Defaults follow references and compositions, including array items' `contentEncoding`. A `const` or inferred shape does not replace an explicit `type`. If the generator cannot determine a default, it warns; set `encoding.contentType` or an explicit style. Unnamed fields use the client's fallback encoding.

### Multipart parts

For `multipart/form-data`, a field's Encoding Object can change how its parts are sent. Array properties repeat the field and apply it to each item.

`contentType` sets each part's media type. JSON types encode values as JSON; other types encode text. A `Blob` or buffer uses the specified type, preserving a `File`'s name. With `text/plain`, non-file values remain text fields. Other explicitly typed parts are files named `blob` unless a `File` supplies its name; some servers treat them as uploads.

Setting `style`, `explode`, or `allowReserved` switches the field to text serialization, even at their default values. It overrides `contentType` and uses URL-encoded form rules without percent-encoding. Supported styles are `form`, `spaceDelimited`, `pipeDelimited`, and `deepObject`. Files or buffers nested in these fields are rejected; send them in a ready `FormData`. OpenAPI 3.0 applies these style fields only to URL-encoded forms.

Part headers other than `Content-Type`, nested/positional encodings, unsupported styles, and content-type lists or wildcards are ignored with warnings. Supply a typed `Blob`, ready `FormData`, or fully encoded body when these features are needed.

### Serialization

The contract controls path, query, and header styles (`label`, `matrix`, `pipeDelimited`, `deepObject`, and others), `allowReserved`, JSON `content` parameters, and the OpenAPI 3.2 `querystring`. For example, `deepObject` encodes a field as `created[gte]=1`.

Plain records and native buffers from another JavaScript realm, such as a same-origin iframe, retain their ordinary encodings. Native body detection checks the value's brand rather than trusting `Symbol.toStringTag`. Value handling follows these rules:

- `Date` values become ISO strings.
- Missing, `null`, or `undefined` path parameters reject.
- Style-based query and form encoding omits `null` and `undefined` fields and array elements. Headers and other multipart parts omit nullish values too.
- Path and header arrays serialize nullish elements as the text `null` or `undefined`.
- JSON query parameters, JSON-encoded form fields, and JSON-typed multipart parts preserve `null` as the text `null`; `undefined` fields are omitted. JSON content follows JSON serialization rules. A `Blob` is rejected anywhere the client writes text or JSON: inside JSON bodies, form fields, object parts, parameters, and headers.

Path, query, and URL-encoded form values are percent-encoded. Commas used as list delimiters remain literal; space and pipe delimiters are encoded. With `allowReserved`, existing percent-encodings are preserved, and reserved characters remain literal except for:

- Paths: `?`, `#`, `[`, and `]`.
- Query parameters and form fields: the same characters, plus `&`, `=`, and `+`.

Path values that create an empty segment, `.` or `..` are rejected because URL normalization would target a different resource.

## Responses

### Status handling

Response types and streaming endpoint selection follow the operation's declared statuses:

- A range such as `4XX` stands for each of its statuses not declared on their own.
- If any 2xx status is declared, the types assume successful responses use one of those statuses. `default` covers all other statuses, including 2xx statuses when none are declared.
- Without `default`, an undeclared 3xx, 4xx, or 5xx status has an `unknown` body, and so does a 2xx status when no 2xx is declared.
- `HEAD` responses and statuses 204, 205, and 304 have no content, even if the description declares content through an explicit status, range, or `default`. A 304 is a failure result with `error: null`; its `json()` rejects and has type `Promise<never>`. Other statuses use the declared content, or no content when none is declared.
- The types follow the description for opaque browser responses (status 0, from `mode: "no-cors"` or `redirect: "manual"`) and statuses outside 100–599. Runtime responses may differ.

### Results

`api.result()` reads the complete response body, or cancels it for `HEAD` and bodyless statuses, allowing the connection to be reused. The actual `Content-Type` determines decoding:

- JSON (`…/json`, `…+json`): parsed; an empty body, or one of only JSON whitespace (spaces, tabs, line breaks), is no content. A body that does not parse rejects, with the status in the message.
- Other `text/*`: a string.
- No content (`HEAD`, 204, 205, 304, or an empty body without a content type): `undefined`.
- Anything else: a `Blob`.

The result contains four fields:

| Field      | Meaning                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------- |
| `data`     | Decoded body for a 2xx response; otherwise `undefined`.                                   |
| `error`    | Decoded body for any other status, or `null` if there is no body; `undefined` on success. |
| `status`   | The response status, used to narrow `data`, `error`, and `response`.                      |
| `response` | The typed `Response`, with its body already read. Use it to inspect headers.              |

Check `error === undefined` to identify success and narrow `data`, including after destructuring. A truthiness check such as `if (error)` cannot rule out an empty error body (`null`), so `data` may remain possibly `undefined`.

Use the result's top-level `status` to narrow by status. TypeScript cannot narrow `data` and `error` through the nested `response.status`.

```ts
const { data, error } = await api.result("GET /pets", { query: { limit: 10 } })
if (error === undefined) {
  console.log(data.length) // data: Schemas.Pet[]
} else {
  console.warn(error?.message ?? "No error body") // error: Schemas.Error | null
}
```

`data` is the union of decoded bodies for successful statuses; `error` covers the others. Without a declared `default`, undeclared error statuses keep `error` as broad as `{} | null` until a status check narrows it.

The server chooses the response media type. A response declared as both JSON and XML therefore produces `Schemas.Pet | Blob`. For a schema `T`, `application/*` produces `T | Blob`, and `*/*` produces `T | string | Blob`. `text/*` also covers JSON such as `text/json`, so it produces `unknown` unless its schema says which strings. Narrow these unions before accessing schema properties. Binary string annotations project to strings for JSON; wildcard results also include the text or `Blob` alternatives their media range permits. Use `api.fetch()` and `blob()` for downloads.

### Typed responses

`api.fetch()` returns a `TypedResponse`. Its `ok` and `status` fields narrow the response, and `json()` returns the declared JSON type for that status, including JSON-compatible wildcard media types. Raw bytes under a wildcard are typed as `unknown`, including unions of raw bytes and structured schemas. Where no content is declared, `json()` is typed as `Promise<never>` because parsing an empty body rejects.

The remaining API is the standard `Response`: `headers`, `text()`, `blob()`, and the `body` stream. Read or cancel unused bodies (`response.body?.cancel()`) so the connection can be reused.

```ts
const response = await api.fetch("GET /pets/{petId}", { params: { petId: 1 } })
if (response.ok) {
  const pet = await response.json() // Schemas.Pet
  console.log(pet.name)
} else if (response.status === 404) {
  const error = await response.json() // Schemas.Error
  console.warn(error.message)
} else {
  console.error(response.status, await response.text())
}
```

## Streams

`api.stream()` returns a native `ReadableStream<Item>` synchronously. Consume it with `for await`, `getReader()`, `pipeThrough()`, or `pipeTo()`. The client owns parsing and SSE reconnection; application processing belongs to the consumer.

```ts
const controller = new AbortController()
try {
  for await (const event of api.stream("GET /events", {
    signal: controller.signal,
    retry: false,
  })) {
    console.log(event.event, event.data)
  }
} finally {
  controller.abort()
}
```

This example reads one SSE connection. Omit `retry: false` to reconnect after EOF. For a long-lived subscription, also call `controller.abort()` from the application's shutdown or unsubscribe handler. Errors during iteration throw at the consuming loop; its `finally` still runs.

### Media selection

When the endpoint declares one supported streaming media type, `accept` is optional. With multiple supported media types, supply the exact full declaration, including its spelling and parameters, such as `accept: "application/x-ndjson; charset=utf-8"`. This selection narrows the item type. `StreamMedia<Endpoints, K>` lists valid selections and `EndpointStreamItem<Endpoints, K, M>` gives the corresponding item type.

The stream sets `Accept` to the selected declaration, overriding any Accept header in defaults or call headers. A successful response must have a matching media type essence (case and parameters are ignored for this check) and an unused, unlocked body. A refused status or invalid response raises `StreamResponseError`; its `response` retains status and headers after its body is canceled. HTTP 204 closes the stream without reading a body.

### Demand and memory

The first read or pipe demand builds the request, snapshots its inputs and encoded body, and starts transport. Creating the stream or merely acquiring a reader does not fetch. Mutations before first demand affect the request; after that point, the subscription keeps the same request inputs across SSE attempts.

The stream uses a high water mark of zero and adds no application event queue. Each demand parses the next record; a slow consumer pauses parsing and later response reads. This does not bound total memory: one record, an already received transport chunk, and the buffered replay request body can each be arbitrarily large. The runtime and transport may buffer additional bytes independently.

### SSE messages

The client parses UTF-8 chunks and SSE fields into messages with these properties:

| Property | Value                                                                 |
| -------- | --------------------------------------------------------------------- |
| `data`   | String formed by joining the event's data lines with newlines.        |
| `event`  | Event name, or `"message"` when none is given.                        |
| `id`     | Current event cursor. An empty `id:` clears it.                       |
| `retry`  | Optional reconnection interval in milliseconds supplied in the event. |

Named and default events are both emitted. Comments and blocks without data emit no message. An incomplete event at EOF is discarded. The resume ID commits only when its block completes, including blocks without data; incomplete blocks cannot advance it. IDs are sent as UTF-8 in `Last-Event-ID` on reconnection, and an empty ID removes that header.

The operation's `itemSchema` narrows standard message fields, including literal event names and unions. Without it, messages use `StreamMessage`. Additional schema properties are not synthesized. `data` remains text even when it contains JSON; parse it according to your protocol. See [sequential content](./openapi.md#sequential-content) for schema rules.

### JSON line records

`application/jsonl` and `application/x-ndjson` emit one parsed JSON value per UTF-8 line. Objects, arrays, strings, numbers, booleans, and `null` are allowed. LF and CRLF delimit records, and a valid final record without a trailing newline is emitted before EOF closes the stream.

Blank or whitespace-only lines, invalid JSON, a byte order mark, and malformed UTF-8 error the stream with `StreamParseError`. Its `line` property is one-based and its `cause` retains the parsing or decoding failure. Error messages omit record contents. Parsing does not validate the operation's schema.

JSON line streams have no automatic retry and reject a `retry` option. Transport, body reading, and parsing failures propagate to the consumer. Reopening after an error is an application decision; records already received could be delivered again.

### Reconnection

SSE reconnects within the same stream by default, beginning with a 1000 ms delay and no retry limit. Configure `retry: { delay: 500, maxRetries: 3 }` or disable reconnection with `retry: false`. `delay` and `maxRetries` must be non-negative safe integers. `maxRetries` counts total additional managed connection attempts for the subscription; successful events do not reset it. `maxRetries: 0` permits only the initial attempt.

| Outcome                                                                                               | SSE action                                                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Normal EOF                                                                                            | Reconnect after the current interval; close normally when retries are exhausted.              |
| HTTP 204                                                                                              | Close normally.                                                                               |
| Actual transport or response-read failure; HTTP 408, 429, or 500–599                                  | Retry after the current interval; error with the original failure when retries are exhausted. |
| Other HTTP error, invalid media or body, request construction error, or middleware's own thrown error | Error the stream immediately.                                                                 |
| Call signal aborted                                                                                   | Error immediately with `signal.reason`, including while paused between reads.                 |

A valid SSE `retry:` field consists only of ASCII digits and must represent a safe integer. It replaces the subscription's current interval. A valid `Retry-After` on a retryable HTTP response increases that attempt's wait to the larger of its value and the current interval; it does not change the interval for subsequent attempts. With retries disabled, normal EOF closes and errors propagate directly.

Each managed attempt uses the [same encoded request body](#request-bodies) and traverses the full middleware chain. The latest completed block's cursor is sent as `Last-Event-ID`. Events may be delivered more than once; applications that need deduplication should use their IDs. Attempts initiated inside retry middleware are outside `maxRetries`.

### Cancellation and pipes

Aborting the call's signal errors the stream with `signal.reason`, cancels active reads and transport, clears a pending retry timer, and prevents further managed attempts. It works before first demand and while the consumer is paused. Breaking out of `for await`, calling `reader.cancel()`, or canceling an unlocked stream performs cleanup and closes consumption normally. Releasing a reader's lock alone does not cancel the subscription; cancel it or abort the signal when finished.

Standard pipe cancellation and error propagation apply. Await or handle the promise returned by `pipeTo()`:

```ts
const events = api.stream("GET /events", { retry: false })
try {
  await events.pipeTo(
    new WritableStream({
      write(event) {
        console.log(event.data)
      },
    }),
  )
} catch (error) {
  console.error("Event processing stopped", error)
}
```

A destination error cancels its source unless pipe options disable cancellation. Handle failures from your own asynchronous processing too. Subscriptions continue when a browser page becomes hidden; use a call signal for application shutdown in browsers and Node.

## Middleware

Middleware wraps every request made by `fetch`, `result`, and `stream`, including stream reconnections. Use it for authentication, timeouts, retries, or logging. Each function receives a `Request` and `next`, and resolves to a `Response`. Call `next(request)` to continue through the remaining middleware. Code before `next` handles the request; code after it handles the response; a `try`/`catch` around it handles failures.

The first middleware runs outermost. The client's `fetch` option sends the request after the last middleware:

```ts
import { createClient, defineMiddleware } from "openapi-shape/client"
import { contract } from "./api"

// A fresh token for every request, set on a copy, out of sight of the middleware around it.
const auth = defineMiddleware(async (request, next) => {
  const authorized = new Request(request)
  authorized.headers.set("authorization", `Bearer ${await getToken()}`)
  return next(authorized)
})

// A 10-second timeout for every request.
const timeout = defineMiddleware((request, next) => {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  return next(new Request(request, { signal }))
})

// Each request's method, URL, status, and time.
const logger = defineMiddleware(async (request, next) => {
  const start = performance.now()
  const response = await next(request)
  console.log(request.method, request.url, response.status, performance.now() - start)
  return response
})

export const api = createClient(contract, {
  baseUrl: "https://api.example.com/v1",
  middleware: [logger, timeout, auth],
})
```

`defineMiddleware()` provides contextual types and returns the same function. `Middleware` is the middleware type; `Fetcher` is the type of both `next` and the client's `fetch` option.

A middleware may forward a different request, return a response without calling `next`, or call `next` repeatedly. Each call continues through the remaining middleware.

### Requests, bodies, and retries

- Middleware receives the same `Request` object passed by its caller. In-place changes remain visible to outer middleware, so an outer logger could expose a newly added token. Forward a copy with `new Request(request)` or `new Request(request, init)` to isolate changes. These constructors take over the original body.
- Bodies can be read only once. For retries, clone the request before the first attempt. For finite responses, a `response.clone()` can be read while returning the original. Avoid `clone().text()` on indefinite streams: it waits for EOF, and teeing a response can buffer unconsumed data. Observe stream response status and headers in middleware around the same request instead of making a separate observation request. Cancel discarded response bodies with `response.body?.cancel()` so their connections can be reused.
- Preserve `request.signal` when constructing replacement requests so stream cancellation reaches transport and response reading. `new Request(request, init)` preserves it unless `init.signal` replaces it; combine additional signals with `AbortSignal.any` as above.
- Stream reconnection creates a fresh request and reruns the chain. Retry middleware can add attempts within each connection attempt; those attempts do not count toward the stream's `maxRetries`. Middleware's own thrown errors are fatal to SSE; an actual transport rejection passed through unchanged is eligible for retry.
- A function that takes only a request also qualifies as middleware and can stop the chain. Put transport test doubles in the `fetch` option so every middleware still runs.

### Credentials and timeouts

Put static credentials in the client's `headers` defaults. Use middleware when credentials need to be refreshed for each request.

A call's `signal` limits the whole call, including a stream subscription's retries. A timeout created in middleware limits each request that passes through it; for a stream, that timeout also applies while its response body is being read. Client-wide options exclude `signal`: sharing one timeout signal across all requests would cancel every request after it expires.

## Typed wrappers

The client exports helper types for functions that forward calls. `Endpoints` is the generated description of request fields and responses; `K` selects one endpoint. These helpers derive call arguments, decoded data, and stream messages from that description.

| Method   | Endpoint keys               | Arguments                     | Data                                                               |
| -------- | --------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `fetch`  | `Endpoint<Endpoints>`       | `EndpointArgs<Endpoints, K>`  | The returned `TypedResponse` narrows by status.                    |
| `result` | `ResultEndpoint<Endpoints>` | `EndpointArgs<Endpoints, K>`  | `EndpointData<Endpoints, K>` is the decoded success data.          |
| `stream` | `StreamEndpoint<Endpoints>` | `StreamArgs<Endpoints, K, M>` | `EndpointStreamItem<Endpoints, K, M>` is the selected parsed item. |

The argument types preserve required parameters and bodies. Constrain a wrapper's endpoint to the key type for its method; a single call cannot take a union of endpoint keys. For streams, `M` extends `StreamMedia<Endpoints, K>` and defaults to all supported media; preserve it in wrappers so `accept` narrows the returned `ReadableStream`. `EndpointMessage<Endpoints, K>` remains the SSE-specific message helper. `StreamOptions` describes media selection and retry settings; `StreamRetryOptions` contains `delay` and `maxRetries`.
