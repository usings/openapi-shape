# Client

`openapi-shape/client` turns [the generated module](./output.md) into a typed `fetch`. Each call builds a standard `Request` the way the description declares (parameter styles, media types, form encodings) and sends it with `fetch`; the response is a standard `Response`, typed by status. The client is one dependency-free module that runs wherever `fetch` does. It does not validate responses.

```ts
import { createClient } from "openapi-shape/client"
import { contract } from "./api"

const api = createClient(contract, { baseUrl: "https://api.example.com/v1" })

const { data, error, status } = await api.result("GET /pets/{petId}", {
  params: { petId: 1 },
})
if (error === undefined) console.log(data.name) // data: Schemas.Pet
else if (status === 404) console.warn(error.message) // error: Schemas.Error
```

## Creating a client

`createClient(contract, options?)` takes the generated `contract`, which carries the generated `Endpoints` in its type, and these options:

| Option                  | Description                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`               | The URL endpoint paths go under, such as `https://api.example.com/v1`, without a query or fragment. Without it, URLs are relative, as `fetch` takes them: fine in a browser, not in Node. |
| `fetch`                 | Sends each `Request` and resolves to its `Response`. Default: the global `fetch`. See [Middleware](#middleware).                                                                          |
| Any `RequestInit` field | Defaults for every request: `headers`, `credentials`, `cache`, and so on, but not `signal`. A call's own fields override them; its headers are set over these.                            |

## Two calls

| Call                          | Resolves to                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `api.result(endpoint, init?)` | `{ data, error, status, response }`: the body, read and decoded, as `data` for a 2xx status or `error` for any other, never both. |
| `api.fetch(endpoint, init?)`  | The `Response`, typed by status, its body unread, for streams, downloads, and anything else `fetch` does.                         |

Neither rejects for an HTTP status, as `fetch` does not. A network failure, or a body that does not match its `Content-Type`, rejects; so does a request that cannot be built (a missing path parameter, say), with a `TypeError`, as `fetch` does. Both take the same arguments, and both narrow by `status`:

```ts
const res = await api.fetch("GET /pets/{petId}", { params: { petId: 1 } })
if (res.ok) {
  const pet = await res.json() // Schemas.Pet
} else if (res.status === 404) {
  const error = await res.json() // Schemas.Error
}
```

### What a call takes

The second argument takes any `RequestInit` field but `method` (`signal`, `cache`, `keepalive`, …), and these, typed by the operation; it is required exactly when the operation requires something. An endpoint the API does not have fails to compile with an error on the endpoint argument, whether or not a second argument is supplied:

| Field         | Rule                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params`      | Required when the path has parameters.                                                                                                                                                                                     |
| `query`       | Required when any query parameter is required.                                                                                                                                                                             |
| `headers`     | Optional. Declared header parameters are type-checked and serialized by their style; other headers are allowed. A `Headers` or its entries are taken as they are. Set over the client's headers and the body's media type. |
| `body`        | Required when the request body is required. Not taken with `GET` or `HEAD`, which `fetch` cannot send a body with.                                                                                                         |
| `contentType` | Which declared media type `body` is. May be omitted for the default: the declared `application/json` one, parameters and all, where one alone is; else the only one declared.                                              |

Cookie parameters are typed in `Endpoints`, but a call does not take them: a browser sends its own cookies, and elsewhere a `cookie` header does.

### Request bodies

What `body` may be follows its media type:

| Media type                                       | `body`                                  | Sent as                                                                                                             |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| JSON: `…/json`, `…+json`, `*/*`, `application/*` | The schema's type                       | JSON                                                                                                                |
| `application/x-www-form-urlencoded`              | The schema's type, or an encoded string | Fields serialized as their Encoding Objects say (`deepObject` as `metadata[key]=value`, …)                          |
| `multipart/form-data`                            | The schema's type                       | `FormData`: a `Blob` or buffer is a file, other values text fields (objects as JSON), and arrays repeat their parts |
| `text/*`, except `text/event-stream`             | A string                                | As given                                                                                                            |
| Anything else                                    | A `Blob`, buffer, stream, or string     | As given                                                                                                            |

A `Blob`, `FormData`, `URLSearchParams`, buffer, or stream is taken for every media type and passed through. `FormData` and `URLSearchParams` bring their own content type; anything else is labelled with the media type the call names, or else the operation's default unless that is JSON. Otherwise, as for a wildcard such as `image/*`, a `Blob`'s own type applies. Streams, web or Node.js, are sent in half duplex. To label a multipart part, as some servers need for a JSON part, append a `Blob` of that type, or pass a `FormData` of your own.

### Serialization

Parameters are encoded as the contract declares: every path, query, and header style (`label`, `matrix`, `pipeDelimited`, `deepObject` as `created[gte]=1`, …), `allowReserved`, JSON `content` parameters, and the 3.2 `querystring`. `Date` values become ISO strings; `null` and `undefined` parameters, fields, and parts are left out.

Values are percent-encoded; commas between list items stay as they are, and space and pipe delimiters are percent-encoded. A `Blob` is refused wherever the client writes text or JSON (a JSON body, a form field, an object part, a parameter, a header), not sent as `{}`. `allowReserved` keeps reserved characters only where they cannot change the URL: in a path, all but `?`, `#`, `[`, and `]`; in a query or form field, also not `&`, `=`, and `+`; existing percent-encodings stay as they are. A path parameter value that would empty its segment or make it `.` or `..` is refused, since the request would reach another resource.

## Responses

Both calls are typed by the statuses the operation declares:

- A range such as `4XX` stands for each of its statuses not declared on their own.
- A 2xx status is taken to be one the description declares. `default` stands for every other status, and for 2xx ones too when no 2xx is declared.
- Without `default`, an undeclared 3xx, 4xx, or 5xx status has an `unknown` body, and so does a 2xx status when no 2xx is declared.
- A response to `HEAD`, and one with status 204, 205, or 304, has no content, whatever the description declares, under a range or `default` too. A 304 is a failure result with `error: null`; its `json()` rejects and is typed as `Promise<never>`. Every other status carries what the description declares for it, nothing where it declares no content.
- Opaque responses (status 0), from `mode: "no-cors"` or `redirect: "manual"` in a browser, and statuses outside 100–599 are taken as the description says, though they may differ at runtime.

### Results

`api.result` reads the body whatever the status, so the connection is free again, and decodes it by its `Content-Type`:

- JSON (`…/json`, `…+json`): parsed; an empty body, or one of only JSON whitespace (spaces, tabs, line breaks), is no content. A body that does not parse rejects, with the status in the message.
- Other `text/*`: a string.
- No content (`HEAD`, 204, 205, 304, or an empty body without a content type): `undefined`.
- Anything else: a `Blob`.

The body is `data` for a 2xx status and `error` for any other; the other one is `undefined`. A failure's `error` is never `undefined`, but `null` where its body decodes to nothing, so `error === undefined` tells a success, and narrows `data` also once destructured. `if (error)` narrows as far as it can: where an error may be `null`, `data` stays possibly `undefined`. `status` narrows both to that status's body; it is the response's own, beside `data` and `error` because TypeScript narrows them by a field of the result, not through `response.status`. `response` is the typed `Response`, its body read, for its headers.

```ts
const { data, error } = await api.result("GET /pets", { query: { limit: 10 } })
if (error === undefined) {
  console.log(data.length) // data: Schemas.Pet[]
} else {
  console.warn(error?.message ?? "No error body") // error: Schemas.Error | null
}
```

The types follow from the declared content the same way: `data` is the union over the success statuses, and `error` over the others. Where the description declares no `default`, any undeclared status may answer, so `error` alone is no narrower than `{} | null` until `status` narrows it. A response declared as JSON and XML is `Schemas.Pet | Blob`, since the server chooses, and raw bytes under a wildcard (`*/*`) are `unknown`, since the server may label them anything; read a download with `api.fetch` and `blob()`.

### Typed responses

`api.fetch` resolves to a `TypedResponse`: `status` and `ok` narrow it, and `json()` resolves to that status's JSON content, from its `…/json`, `…+json`, or wildcard media types (raw bytes are `unknown` there), or to `never` where the response has no content, since `json()` then rejects. Everything else is the standard `Response`: `headers`, `text()`, `blob()`, and `body`, a stream. As with `fetch`, read or cancel a body you do not need (`res.body?.cancel()`), so the connection can be reused.

### Streams

`api.result` reads a body whole, so event streams and JSON sequences arrive as text or a `Blob`. Read them as they come through `api.fetch`; `Endpoints` types their items for a parser of your own:

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

The `fetch` option is the one place to change how requests are sent: credentials, timeouts, retries, logging, or a test double. It takes each `Request` and resolves to a `Response`:

```ts
import { createClient } from "openapi-shape/client"
import { contract } from "./api"

export const api = createClient(contract, {
  baseUrl: "https://api.example.com/v1",
  // A fresh token and a 10-second timeout for every request.
  fetch: async (request) => {
    request.headers.set("authorization", `Bearer ${await getToken()}`)
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    return fetch(request, { signal })
  },
})
```

Static credentials can go in `headers` instead. The client's options take no `signal`: one signal would be shared by every request, and a timeout would cancel them all once it ran out. A timeout belongs here, where each request gets its own, or in a call's `signal`.

## Passing calls on

A function that passes a call on takes the endpoint as an `Endpoint` and the rest as `EndpointArgs`, and keeps every type a call has; `EndpointData` is the data of the endpoint's 2xx responses, for what it returns. A query for TanStack Query, which counts a request as failed only when its function throws:

```ts
import type { Endpoint, EndpointArgs, EndpointData } from "openapi-shape/client"
import { createClient } from "openapi-shape/client"
import type { Endpoints } from "./api"
import { contract } from "./api"

const api = createClient(contract, { baseUrl: "https://api.example.com/v1" })

export function query<K extends Endpoint<Endpoints>>(
  endpoint: K,
  ...args: EndpointArgs<Endpoints, K>
) {
  return {
    queryKey: [endpoint, ...args] as const,
    queryFn: async (): Promise<EndpointData<Endpoints, K>> => {
      const result = await api.result(endpoint, ...args)
      if (result.error !== undefined) {
        throw new Error(`${endpoint} answered ${result.status}`, { cause: result.error })
      }
      return result.data
    },
  }
}

const pet = await query("GET /pets/{petId}", { params: { petId: 1 } }).queryFn() // Schemas.Pet
```

These helpers bind a concrete `Endpoints` map and make the called key `K` generic. The check of `error` narrows `data` to `EndpointData<Endpoints, K>` even while the endpoint is a type parameter. Returning unchecked `data`, or returning `error`, fails to compile when it could violate that success type. Callers retain the data type of the endpoint they pass.

Handwritten maps with string or template index signatures are also callable; a literal call such as `"HEAD /health"` supplies the method used to determine its body and response types. Each call accepts one endpoint, not a union of distinct endpoints.

Both keeping the result together and destructuring `data` and `error` before the check are supported. The scale test covers 300 endpoints with distinct object-array bodies and multiple success statuses, called directly and through both generic wrapper forms. It checks status narrowing, array methods, and rejection of unchecked returns as well as the returned data types.
