# Client

`openapi-shape/client` uses [the generated contract](./output.md#the-runtime-contract) to build typed requests with standard `Request` and `Response` objects. It handles parameter styles, media types, and form encodings, and supports middleware around each request. The client has no dependencies and uses standard Fetch API globals.

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

## Two calls

| Call                          | Resolves to                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `api.result(endpoint, init?)` | `{ data, error, status, response }`: the body, read and decoded, as `data` for a 2xx status or `error` for any other, never both. |
| `api.fetch(endpoint, init?)`  | The `Response`, typed by status, its body unread, for streams, downloads, and anything else `fetch` does.                         |

Both calls accept the same arguments and resolve for any HTTP status, including errors. They reject for network failures, middleware errors, or requests that cannot be built. Missing path parameters reject with a `TypeError`. `result` also rejects if the body cannot be decoded according to its `Content-Type`.

Use `result` for decoded data, or `fetch` to [read the response yourself](#typed-responses).

For typed wrappers, `openapi-shape/client` exports `Endpoint<Endpoints>` for callable endpoint keys, `EndpointArgs<Endpoints, K>` for arguments and their requiredness, and `EndpointData<Endpoints, K>` for decoded success data.

### What a call takes

The second argument combines request options such as `signal`, `cache`, and `keepalive` with the operation's typed inputs below. The endpoint determines `method`; the client types `headers` and `body` from the operation.

This argument is required when `params`, `query`, or `body` is required. Declared headers are optional per call because defaults or middleware may provide them. Unknown endpoints and methods forbidden by Fetch (`CONNECT`, `TRACE`, `TRACK`) produce compile errors on the endpoint argument.

| Field         | Rule                                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params`      | Required when the path has parameters; values must be own properties of `params`, not inherited.                                                                                                                                                                |
| `query`       | Required when any query parameter is required, or when the whole `querystring` parameter is required, even if all of its properties are optional.                                                                                                               |
| `headers`     | Optional. Object values use the declared parameter types and styles; additional headers are allowed. A `Headers` instance or entries are passed through. Call headers override defaults. `FormData` and `URLSearchParams` always supply their own content type. |
| `body`        | Required when the request body is required. Not taken with `GET` or `HEAD`, which `fetch` cannot send a body with.                                                                                                                                              |
| `contentType` | The declared media type of `body`. Optional when there is a default: the sole `application/json` entry, including media type parameters, or otherwise the sole declared media type.                                                                             |

Cookie parameters appear in `Endpoints`, but client calls have no cookie input. Browsers manage cookies; other runtimes can send a `cookie` header.

### Request bodies

The media type determines which body values the client accepts and how it sends them:

| Media type                                       | `body`                                  | Sent as                                                                                    |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| JSON: `…/json`, `…+json`, `*/*`, `application/*` | The schema's type                       | JSON                                                                                       |
| `application/x-www-form-urlencoded`              | The schema's type, or an encoded string | Fields serialized as their Encoding Objects say (`deepObject` as `metadata[key]=value`, …) |
| `multipart/form-data`                            | The schema's type                       | `FormData`: schema-derived or explicit part types; arrays repeat their parts               |
| Other `text/*`, except `text/event-stream`       | A string                                | As given                                                                                   |
| Anything else                                    | A `Blob`, buffer, stream, or string     | As given                                                                                   |

A `Blob`, `FormData`, `URLSearchParams`, buffer, or stream passes through unchanged. `FormData` and `URLSearchParams` set their own content type. Web and Node.js streams use half duplex.

Other ready bodies use the selected media type or the generated [`contentType` default](./output.md#the-runtime-contract). An `application/json` default does not relabel them, even when it has parameters. Without a label, a `Blob` uses its own type. Wildcards such as `image/*` do not label a body.

Only `multipart/form-data` is encoded automatically. For other multipart types, provide an encoded body with its content type and boundary.

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

Both calls derive their response types from the operation's declared statuses:

- A range such as `4XX` stands for each of its statuses not declared on their own.
- If any 2xx status is declared, the types assume successful responses use one of those statuses. `default` covers all other statuses, including 2xx statuses when none are declared.
- Without `default`, an undeclared 3xx, 4xx, or 5xx status has an `unknown` body, and so does a 2xx status when no 2xx is declared.
- `HEAD` responses and statuses 204, 205, and 304 have no content, even if the description declares content through an explicit status, range, or `default`. A 304 is a failure result with `error: null`; its `json()` rejects and has type `Promise<never>`. Other statuses use the declared content, or no content when none is declared.
- The types follow the description for opaque browser responses (status 0, from `mode: "no-cors"` or `redirect: "manual"`) and statuses outside 100–599. Runtime responses may differ.

### Results

`api.result()` consumes the response body, or cancels it for `HEAD` and bodyless statuses, allowing the connection to be reused. It decodes the body by `Content-Type`:

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

The server chooses the response media type. A response declared as both JSON and XML therefore produces `Schemas.Pet | Blob`. For a schema `T`, `application/*` produces `T | Blob`, and `*/*` produces `T | string | Blob`. `text/*` also covers JSON such as `text/json`, so it produces `unknown` unless its schema says which strings. Narrow these unions before accessing schema properties. Raw bytes declared under these wildcards produce `unknown`, since the actual content type determines decoding. Use `api.fetch()` and `blob()` for downloads.

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

### Streams

`api.result()` buffers the entire body, so it returns event streams and JSON sequences as text or a `Blob`. Use `api.fetch()` to read incrementally. The generated `Endpoints` types describe the items for your own parser:

```ts
const { body } = await api.fetch("GET /events")
const reader = body?.pipeThrough(new TextDecoderStream()).getReader()
while (reader) {
  const { done, value } = await reader.read()
  if (done) break
  console.log(value) // event stream text, as it arrives
}
```

## Middleware

Middleware wraps requests for authentication, timeouts, retries, or logging. Each function receives a `Request` and `next`, and resolves to a `Response`. Call `next(request)` to continue through the remaining middleware. Code before `next` handles the request; code after it handles the response; a `try`/`catch` around it handles failures.

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
- Bodies can be read only once. For retries, clone the request before the first attempt. To inspect a response body, read a `response.clone()` and return the original; consuming the original causes `api.result()` to reject. Cancel discarded response bodies with `response.body?.cancel()` so their connections can be reused.
- A function that takes only a request also qualifies as middleware and can stop the chain. Put transport test doubles in the `fetch` option so every middleware still runs.

### Credentials and timeouts

Put static credentials in the client's `headers` defaults. Use middleware when credentials need to be refreshed for each request.

Set timeouts in middleware or a call's `signal`. Client-wide options exclude `signal`: sharing one timeout signal across all requests would cancel every request after it expires.
