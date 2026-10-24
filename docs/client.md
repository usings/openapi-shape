# Client

`openapi-shape/client` uses the generated `contract` to serialize requests and type responses. It has no dependencies and uses Fetch and Web Streams. Payloads are not checked against schemas; see [support boundaries](./openapi.md#support-boundaries).

```ts
import { createClient } from "openapi-shape/client"
import { contract } from "./api"

const api = createClient(contract, { baseURL: "https://api.example.com/v1" })
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

## Calls

| Method                        | Endpoints              | Returns                                                                  |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `api.result(endpoint, init?)` | Non-streaming          | A promise of `{ data, error, status, response }`, with the body decoded. |
| `api.stream(endpoint, init?)` | Streaming              | A native `ReadableStream<Item>`, returned synchronously.                 |
| `api.fetch(endpoint, init?)`  | All callable endpoints | A promise of a typed `Response`, with its body unread.                   |

All methods share request inputs, defaults, and middleware. `fetch` and `result` reject on request construction, transport, or middleware errors. HTTP error statuses resolve normally; `result` also rejects if decoding fails. Stream errors reach the consumer through reads or iteration.

A streaming endpoint declares a successful SSE, JSONL, or NDJSON response. Use `stream` for these endpoints and `result` for the others; `fetch` can call either. See [Streams](#streams) for endpoint and media selection, and [Middleware](./middleware.md) for shared request wrappers.

## Creating a client

`createClient(contract, options?)` infers the API types. Generate the contract with the package installed in your application; see [format compatibility](./generated.md#format-compatibility).

| Option                 | Purpose                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseURL`              | Prefix for endpoint paths, such as `https://api.example.com/v1`. No query or fragment. Browsers can omit it for relative URLs; Node requires an absolute URL. |
| `headers`              | Default headers; call headers take precedence.                                                                                                                |
| `middleware`           | Request wrappers, first outermost. See [Middleware](./middleware.md).                                                                                         |
| `fetch`                | Transport taking a `Request` and resolving to a `Response`. Defaults to global `fetch`; useful for custom transports and test doubles.                        |
| Other request defaults | `RequestInit` fields except `method`, `body`, and `signal`, overridden per call.                                                                              |

## Requests

### What a call takes

The second argument combines the operation's inputs with request options such as `signal`, `cache`, and `keepalive`. It is required when `params`, `query`, or `body` is required.

| Field         | Purpose                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `baseURL`     | Optional string or `URL` replacing the client's default endpoint prefix for this call.          |
| `params`      | Path parameter values, required when the path has parameters.                                   |
| `query`       | Query parameters or the complete OpenAPI 3.2 `querystring` value.                               |
| `headers`     | Optional typed header values, a `Headers` instance, or entries. Additional headers are allowed. |
| `body`        | Request body, required when the operation requires one. Not accepted for `GET` or `HEAD`.       |
| `contentType` | Selects a declared request media type when needed.                                              |

The endpoint supplies the method and path. Unknown endpoints fail before transport; Fetch-forbidden methods are excluded from generated endpoints. Headers are optional per call because defaults or middleware may provide them. Cookies are managed by browsers; other runtimes can send a `cookie` header.

`query` is required if any ordinary query parameter is required, or if the complete `querystring` is required, even when its properties are optional. Path parameter values must be own properties of `params`.

A per-call `baseURL` works with `fetch`, `result`, and `stream` without changing the client or other calls. Endpoint paths append to its path prefix, with trailing slashes removed. Both client and per-call values reject queries and fragments. Omitting it or passing `undefined` uses the client default. Headers, credentials, and middleware still apply. For SSE, the address is fixed at first demand and reused on reconnection.

### Request bodies

The client encodes structured JSON, URL-encoded forms, and `multipart/form-data`. Other text media take strings; other media take an encoded string or ready body. The default media type is the sole `application/json` declaration, including its parameters, or otherwise the sole declared media type. With no default, supply `contentType`.

```ts
await api.result("POST /pets", { body: { name: "Milo" } })
await api.fetch("POST /upload", {
  baseURL: "https://uploads.example.com",
  body: { file, name: "portrait" },
})
```

Ready bodies (`Blob`, buffers, `FormData`, and `URLSearchParams`) use their own bytes. `FormData` and `URLSearchParams` supply their own content type, overriding call headers. Other ready bodies use the selected or generated content type; without a concrete label, a `Blob` uses its own type. Wildcards cannot label a body.

`fetch` and `result` also accept Web streams and async iterables such as Node.js streams, sent with half duplex. `stream` requires [replayable request bodies](#demand-and-request-replay).

Only `multipart/form-data` is encoded automatically among multipart types. For others, supply an encoded body with its media type and boundary. Sequential media require an encoded body too; arrays are not automatically converted into SSE or JSON lines. See [media projections](./openapi.md#media-types) for the full mapping.

## Responses

### Results

`result` reads the complete body and returns `{ data, error, status, response }`. On success, `data` is the decoded body and `error` is `undefined`. On other statuses, `data` is `undefined` and `error` is the decoded body, or `null` if there is none. The response body has already been read or canceled; use `response` to inspect headers.

Check `error === undefined` for success. A truthiness check misses error values such as `null`, `false`, or an empty string. The top-level `status` narrows the corresponding data and error types, including after destructuring; the nested `response.status` cannot perform that narrowing.

The actual `Content-Type` selects decoding:

| Response                  | Decoded value                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| JSON (`…/json`, `…+json`) | Parsed JSON; empty or JSON-whitespace-only content is `undefined`. Invalid JSON rejects. |
| Other `text/*`            | String                                                                                   |
| `HEAD`, 204, 205, 304     | `undefined`; any supplied body is canceled                                               |
| Missing content type      | `undefined` for an empty body, otherwise `Blob`                                          |
| Anything else             | `Blob`                                                                                   |

When an operation declares multiple response media, the decoded type includes their possible values. For example, JSON and XML produce `Schemas.Pet | Blob`. Narrow the value before accessing schema properties. Wildcard and binary projections are described in [media types](./openapi.md#media-types).

### Typed responses

`fetch` returns a `TypedResponse`: `ok` and `status` narrow the response, and `json()` returns the declared JSON type for that status. Other methods and properties are the standard `Response` API. Read or cancel unused bodies so their connections can be reused.

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

For JSON-compatible wildcard media, `json()` uses the declared JSON projection; raw binary alternatives are `unknown`. With no declared content, it returns `Promise<never>` because parsing an empty body rejects.

### Status handling

Response types use exact status declarations before ranges such as `2XX`; a range excludes codes declared individually. If a 2xx status is declared, successful responses are assumed to use those declarations. Otherwise, `default` also covers undeclared successes. Without `default`, undeclared error statuses, and undeclared successes when no 2xx is declared, have unknown bodies.

`HEAD` and statuses 204, 205, and 304 have no content regardless of the description. A 304 is a failure result with `error: null`. Types follow documented statuses, not unexpected runtime responses such as opaque browser status 0 or statuses outside 100–599. An undeclared error body can remain as broad as `{} | null` until narrowed by status.

## Streams

`api.stream()` returns a native `ReadableStream<Item>` synchronously. It uses the same request inputs and defaults as `fetch` and `result`. SSE emits messages whose `data` remains text:

```ts
for await (const event of api.stream("GET /events")) {
  console.log(event.event, event.data)
}
```

SSE reconnects after EOF by default; JSON line streams finish at EOF. [Cancel](#cancellation-and-pipes) a subscription when finished.

JSONL and NDJSON emit parsed JSON values. This example endpoint offers both media types, so `accept` selects one:

```ts
for await (const pet of api.stream("GET /records", { accept: "application/x-ndjson" })) {
  console.log(pet.id, pet.name)
}
```

### Endpoint and media selection

A streaming endpoint has an effective successful response declaring `text/event-stream`, `application/jsonl`, or `application/x-ndjson`. Matching ignores case and media parameters. Wildcards, `HEAD`, bodyless statuses, and media used only by error responses do not qualify. A declaration still qualifies when its schema is `never`.

An endpoint offering both JSON and a supported stream belongs to `stream`; use `fetch` to read its JSON representation. Unsupported sequence formats such as `application/json-seq` are read with `fetch`, or as a `Blob` with `result` when the endpoint has no supported stream. See [status handling](#status-handling) for response precedence.

One supported streaming declaration needs no `accept`. With multiple declarations, use the exact spelling and parameters, such as `"application/x-ndjson; charset=utf-8"`. The selection narrows the item type and overrides any `Accept` header from defaults or call headers. Responses are matched by media essence, ignoring case and parameters.

`StreamResponseError` reports a refused status, invalid media type, or missing, consumed, or locked body. Its `response` retains status and headers after body cleanup. HTTP 204 closes normally. Schema-to-item typing is described in [sequential content](./openapi.md#sequential-content).

### Demand and request replay

Creating a stream or acquiring a reader performs no request. First demand builds and snapshots the request. Mutations before that point affect it; afterward SSE attempts reuse the same inputs. Slow consumers pause parsing and later response reads. There is no application event queue (`highWaterMark: 0`), but individual records, received chunks, replay bodies, and transport buffers are not size-bounded.

Request bodies are encoded and buffered once at first demand. SSE reconnects replay those bytes, including multipart boundaries. Web streams and async iterables are rejected as one-shot bodies before transport. Retrying a POST can repeat an operation.

### SSE messages

SSE messages contain `data: string`, `event: string`, `id: string`, and optional numeric `retry`. Data lines are joined with newlines; the default event name is `"message"`. Named and default events are emitted. Comments and blocks without data emit nothing; incomplete events at EOF are discarded. The cursor commits only on a complete block, even one without data, and is sent as UTF-8 bytes on reconnection.

### SSE reconnection

SSE defaults to a 1000 ms delay with unlimited retries. Set `retry: { delay: 500, maxRetries: 3 }`, or `retry: false` for one connection. Both numbers must be non-negative safe integers. `maxRetries` counts additional managed attempts over the entire subscription; events do not reset it, and `0` permits only the initial connection.

| Outcome                                                                                       | Action                                                            |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Normal EOF                                                                                    | Reconnect; close normally when the retry budget ends.             |
| HTTP 204                                                                                      | Close normally.                                                   |
| Transport/read failure, HTTP 408, 429, or 500–599                                             | Retry; propagate the original failure when the budget ends.       |
| Other HTTP error, invalid response, request construction error, middleware's own thrown error | Error immediately.                                                |
| Aborted call signal                                                                           | Error with `signal.reason`, including while paused between reads. |

An SSE `retry:` field of ASCII digits representing a safe integer replaces the current interval. A valid HTTP `Retry-After` increases only that attempt's wait to the larger of its value and the current interval. With retries disabled, EOF closes and errors propagate.

Each attempt reruns the full [middleware chain](./middleware.md) with the same encoded body and the latest completed cursor in `Last-Event-ID`. Empty IDs clear that header. Resumption does not deduplicate events or guarantee exactly-once delivery. Attempts made inside retry middleware are outside `maxRetries`.

### JSON line records

JSON line streams accept any JSON value, LF or CRLF separators, and a valid final record without a trailing newline. Blank/whitespace-only records, a BOM, invalid JSON, or malformed UTF-8 raise `StreamParseError` with one-based `line` and the original `cause`. Messages omit record contents. A read failure discards any pending partial record.

JSON line streams never reconnect automatically and reject a `retry` option. Reading, transport, and parsing failures propagate to the consumer; reopening and handling possible duplicate records belong to the application.

### Cancellation and pipes

Use a call signal to stop a long-lived subscription:

```ts
const stop = new AbortController()
const events = api.stream("GET /events", { signal: stop.signal })

// In the application's shutdown handler:
stop.abort()
```

An application shutdown handler can call `stop.abort()` while a read is pending. Abort errors the stream with `signal.reason`; reader or stream cancellation closes consumption normally. Both clean up active work and prevent reconnection. Breaking a `for await` loop also cancels; merely releasing a reader lock does not. Call `stream.cancel()` only while the stream is unlocked. Browser visibility changes do not stop subscriptions.

Standard pipe cancellation and error propagation apply. Await `pipeTo()` so destination errors reach the caller:

```ts
await api.stream("GET /events", { retry: false }).pipeTo(
  new WritableStream({
    write(event) {
      console.log(event.data)
    },
  }),
)
```

A destination failure cancels its source unless pipe options disable cancellation. Handle failures from your own asynchronous processing too.

## Typed wrappers

Use the exported helper types to preserve an endpoint's input and result association:

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

| Method   | Endpoint keys               | Arguments                     | Value                                               |
| -------- | --------------------------- | ----------------------------- | --------------------------------------------------- |
| `fetch`  | `Endpoint<Endpoints>`       | `EndpointArgs<Endpoints, K>`  | `TypedResponse`, narrowed by status                 |
| `result` | `ResultEndpoint<Endpoints>` | `EndpointArgs<Endpoints, K>`  | `EndpointData<Endpoints, K>` for success data       |
| `stream` | `StreamEndpoint<Endpoints>` | `StreamArgs<Endpoints, K, M>` | `EndpointStreamItem<Endpoints, K, M>` for each item |

A single call cannot take a union of endpoint keys. A stream wrapper should preserve `M extends StreamMedia<Endpoints, K>` so `accept` narrows its `ReadableStream` item. `EndpointMessage` is the SSE-specific helper; `StreamOptions` describes media selection and `StreamRetryOptions` describes retry settings.

## Serialization reference

Path, query, and header styles come from the contract, including JSON `content` parameters and the OpenAPI 3.2 `querystring`. `deepObject`, for example, encodes `created[gte]=1`.

### Form field defaults

URL-encoded and multipart fields use the encodings of the selected full media type. Without an explicit style, the generator derives these defaults from the schema:

| Field type                    | Default content type                                |
| ----------------------------- | --------------------------------------------------- |
| Object                        | `application/json`                                  |
| Primitive                     | `text/plain`                                        |
| Raw bytes or no explicit type | `application/octet-stream`                          |
| Array                         | The item's default, applied separately to each item |

For example, `meta: { id: 1 }` becomes `meta=%7B%22id%22%3A1%7D` in a URL-encoded body. Arrays of objects repeat the field with one JSON value per item. Form `querystring` parameters follow these rules; ordinary query parameters use parameter styles.

Defaults follow references and compositions, including array items' `contentEncoding`. A `const` or inferred shape does not replace an explicit `type`. If a default cannot be determined, the generator warns; set `encoding.contentType` or a style. Unnamed fields use the client's fallback encoding.

### Multipart parts

Multipart arrays repeat their field. A field's `contentType` sets each part's media type: JSON values are encoded as JSON, other values as text. A `Blob` or buffer keeps its bytes; a `File` keeps its filename. `text/plain` values remain text fields; other explicitly typed non-file values become files named `blob`.

Setting `style`, `explode`, or `allowReserved` selects text serialization, even at default values, and overrides `contentType`. Supported styles are `form`, `spaceDelimited`, `pipeDelimited`, and `deepObject`. They use form rules without percent-encoding. Files and buffers nested in styled fields are rejected; use ready `FormData`. OpenAPI 3.0 applies these style fields only to URL-encoded forms.

Other part headers, nested or positional encodings, unsupported styles, and content-type lists or wildcards are ignored with warnings. Use a typed `Blob`, ready `FormData`, or a fully encoded body for those cases.

### Values and escaping

- `Date` values become ISO strings. Missing or nullish path values reject.
- Style-based query/form fields and array elements omit `null` and `undefined`. Headers and non-JSON multipart parts omit nullish values. Path and header arrays stringify nullish elements.
- JSON parameters and JSON-typed form or multipart fields preserve `null`; undefined properties are omitted. A `Blob` anywhere the client writes text or JSON is rejected.
- Plain records and native buffers from another JavaScript realm keep their ordinary encodings; native detection checks brands instead of `Symbol.toStringTag`.

Path, query, and URL-encoded values are percent-encoded. Commas used as delimiters stay literal; space and pipe delimiters are encoded. `allowReserved` preserves existing percent-encodings and reserved characters except `?`, `#`, `[`, `]` in paths, and additionally `&`, `=`, `+` in queries/forms. Values creating empty, `.` or `..` path segments reject because URL normalization would target another resource.
