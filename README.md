# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]

Generate TypeScript API contracts from OpenAPI 3.0/3.1 JSON or YAML—without generating an entire SDK.

`openapi-shape` turns operations and schemas into a compact declaration file. Use those types directly, or pair them with the optional transport-agnostic client while keeping fetch, axios, ky, ofetch, authentication, retries, caching, and response parsing under your control.

- **Contract-first:** endpoint keys, request inputs, response status maps, schemas, webhooks, and callbacks stay aligned with your OpenAPI document.
- **Client-agnostic:** bring your existing HTTP stack instead of adopting generated runtime code.
- **CI-friendly:** generate from a local file or URL and detect stale output with `--check`.
- **Small runtime footprint:** generated declarations have no runtime dependency; install the client only when you need it.

## Contents

- [Quick Start](#quick-start)
- [Generated Types](#generated-types)
- [CLI](#cli)
- [Typed Client (Optional)](#typed-client-optional)
- [Request Building](#request-building)
- [Integration Examples](#integration-examples)
- [Programmatic API](#programmatic-api)
- [OpenAPI Support](#openapi-support)
- [Limitations](#limitations)

## Quick Start

Requires Node.js 22 or later.

Generate declarations from a local JSON/YAML file or an HTTP(S) URL:

```sh
npx openapi-shape ./openapi.yaml -o src/api.d.ts
```

For scripts and CI, install it as a dev dependency:

```sh
pnpm add -D openapi-shape
pnpm exec openapi-shape ./openapi.yaml -o src/api.d.ts
```

Commit the generated file, or verify it in CI without modifying it:

```sh
pnpm exec openapi-shape ./openapi.yaml -o src/api.d.ts --check
```

Install `openapi-shape` as a regular dependency instead if deployed code imports `openapi-shape/client` at runtime.

## Generated Types

The output is plain TypeScript. Each operation becomes a key in `Endpoints`, and reusable component schemas live in `Schemas`:

```ts
export interface Endpoints {
  "GET /pets": {
    params: void
    query: { limit?: number }
    body: void
    response: { "200": Schemas.Pet[] }
  }
  "POST /pets": {
    params: void
    query: void
    body: Schemas.CreatePet
    response: { "201": Schemas.Pet }
  }
  "GET /pets/{petId}": {
    params: { petId: string }
    query: void
    body: void
    response: { "200": Schemas.Pet }
  }
}

export namespace Schemas {
  export interface Pet {
    id: number
    name: string
  }

  export interface CreatePet {
    name: string
  }
}
```

The shape is intentionally predictable:

- `Endpoints` is keyed by `"METHOD /path"`.
- Each endpoint has `params`, `query`, `body`, and `response`.
- `response` is a map keyed by OpenAPI response keys such as `"200"`, `"404"`, or `"default"`.
- OpenAPI `components.schemas` are grouped under `Schemas`.
- In request slots, `void` means the operation does not use that input. In a response map, it means that status has no response body.
- The generated file can be committed or regenerated in CI.

### Webhooks

OpenAPI 3.1 `webhooks` are emitted as a parallel `Webhooks` interface:

```ts
export interface Webhooks {
  "POST pet.created": {
    query: void
    payload: Schemas.Pet
    reply: { "204": void }
  }
}
```

Webhook entries use the receiving side's vocabulary:

- `payload` is the incoming request body.
- `reply` is the handler's outgoing response.
- `params` is omitted because webhook names do not have URL templates.
- `query` and `headers` describe what the third party sends.

Example handler type:

```ts
import type { Webhooks } from "./api"

function onPetCreated(payload: Webhooks["POST pet.created"]["payload"]) {
  payload.id
}
```

### Callbacks

OpenAPI callbacks are emitted in a parallel `Callbacks` interface. Each key includes the parent operation, callback name, callback method, and runtime expression so entries remain unique across the document:

```ts
export interface Callbacks {
  "POST /subscriptions > onEvent > POST {$request.body#/callbackUrl}": {
    query: void
    payload: Schemas.Event
    reply: { "204": void }
  }
}
```

Callback entries use the same receiving-side `payload` and `reply` vocabulary as webhooks. Inline callbacks and local references to `components.callbacks` are supported.

## CLI

```sh
openapi-shape [options] <source> --output <file>
```

| Argument / option     | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `<source>`            | Local OpenAPI JSON/YAML path or HTTP(S) URL.                          |
| `-o, --output <file>` | Required output path for the generated declaration file.              |
| `--check`             | Exit with a non-zero status when the output file is missing or stale. |
| `--headers`           | Generate typed `headers` fields from OpenAPI `in: header` parameters. |

A typical `package.json` setup keeps generation and verification separate:

```json
{
  "scripts": {
    "gen:api": "openapi-shape ./openapi.json -o src/api.d.ts",
    "check:api": "openapi-shape ./openapi.json -o src/api.d.ts --check"
  }
}
```

## Typed Client (Optional)

`openapi-shape/client` creates one typed request function from the generated `Endpoints` map. It handles URL and request construction; your adapter performs the HTTP call and parses the response.

The client provides compile-time types only. Values returned by the adapter are trusted and are not validated against the OpenAPI schemas at runtime.

```ts
import { createClient, type Adapter } from "openapi-shape/client"
import type { Endpoints } from "./api"

const adapter: Adapter = async ({ method, url, body, headers }) => {
  const response = await fetch(url, { method, body, headers })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  if (response.status === 204) return undefined
  return response.json()
}

export const api = createClient<Endpoints>(adapter, {
  baseURL: "https://api.example.com",
})
```

Calls are checked at compile time:

```ts
const pets = await api("GET /pets", {
  query: { limit: 10 },
})

const created = await api("POST /pets", {
  body: { name: "Buddy" },
})
```

Client return types are inferred from response maps:

- `SuccessOf<T>` is the union of all `2xx` entries.
- If there is no `2xx`, `SuccessOf<T>` uses `default` only when it is the sole response key.
- `ResultOf<T, Status>` extracts one exact status key.

```ts
import type { ResultOf, SuccessOf } from "openapi-shape/client"
import type { Endpoints } from "./api"

type ListPets = SuccessOf<Endpoints["GET /pets"]>
type NotFound = ResultOf<Endpoints["GET /pets/{petId}"], "404">
```

Adapter-specific options stay typed:

```ts
type AdapterOptions = { timeout?: number }

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options?.timeout ?? 30_000)
  try {
    const response = await fetch(url, { method, body, headers, signal: controller.signal })
    return response.status === 204 ? undefined : response.json()
  } finally {
    clearTimeout(timeout)
  }
}

export const api = createClient<Endpoints, AdapterOptions>(adapter, {
  options: { timeout: 5000 },
})

await api("GET /pets", {
  query: { limit: 10 },
  options: { timeout: 1000 },
})
```

## Request Building

The optional client builds adapter input with these rules:

OpenAPI request media types inform the generated body type, but they do not configure runtime serialization. The default client serialization is described below; use `serializeBody` for media types such as `text/plain` that need different encoding.

| Field     | Behavior                                                                                                                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`  | Read from the endpoint key, such as `GET /pets`.                                                                                                                                                                                                                |
| `url`     | `baseURL` plus path params and query string. Path params are URL-encoded. Query arrays become repeated keys, for example `tags=a&tags=b`. `null` and `undefined` query values are skipped. Absolute `http://` and `https://` endpoint paths bypass `baseURL`.   |
| `body`    | `undefined` stays `undefined`. `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`, `ArrayBuffer` views (including typed arrays and `DataView`), and `ReadableStream` pass through unchanged. Other defined bodies — including strings — are JSON-stringified. |
| `headers` | Client-level defaults are merged before body-derived headers and per-call headers. JSON bodies get `content-type: application/json`; passthrough bodies get no automatic content type. Later values override earlier ones case-insensitively. Adapter headers use lowercase names. |
| `options` | Passed through to your adapter after default/per-call merging. Object options are shallow-merged; non-object options are replaced by the per-call value.                                                                                                        |

Customize serialization when your API does not use the defaults:

```ts
export const api = createClient<Endpoints>(adapter, {
  baseURL: "https://api.example.com",
  serializeQuery(query) {
    const params = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) {
      if (value == null) continue
      params.set(name, Array.isArray(value) ? value.join(",") : String(value))
    }
    return params
  },
  serializeBody(body) {
    if (typeof body === "string") {
      return { body, headers: { "Content-Type": "text/plain" } }
    }

    return {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }
  },
})
```

- `serializeQuery` receives the raw query object and returns a query string or `URLSearchParams`.
- `serializeBody` receives each non-`undefined` body and returns the adapter body plus optional headers. Use it when an endpoint expects raw text instead of JSON, as in the `text/plain` example above.
- Per-call headers still override headers returned by `serializeBody`.

## Integration Examples

These examples are recipes. They map the same adapter input to fetch or third-party HTTP clients; keep auth, retries, hooks, and error handling in your adapter or HTTP client.

<details>
<summary>More complete fetch adapter</summary>

This version handles auth headers, typed HTTP errors, empty responses, and content-type based parsing:

```ts
import { createClient, type Adapter } from "openapi-shape/client"
import type { Endpoints } from "./api"

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly response: Response,
  ) {
    super(`HTTP ${status} ${response.statusText}: ${body.slice(0, 200)}`)
    this.name = "HttpError"
  }
}

declare function getToken(): string

const adapter: Adapter = async ({ method, url, body, headers }) => {
  const response = await fetch(url, {
    method,
    body,
    headers: { ...headers, authorization: `Bearer ${getToken()}` },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new HttpError(response.status, errorBody, response)
  }

  const contentLength = response.headers.get("content-length")
  if (response.status === 204 || contentLength === "0") {
    return undefined
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (/^application\/(.*\+)?json/.test(contentType)) return response.json()
  if (contentType.startsWith("text/")) return response.text()
  return response.blob()
}

export const api = createClient<Endpoints>(adapter, {
  baseURL: "https://api.example.com",
})
```

</details>

For third-party adapters, use `Omit<...>` so callers cannot override fields owned by the generated request (`method`, `url`, `body`/`data`, `headers`).

<details>
<summary>axios adapter</summary>

```ts
import axios, { type AxiosRequestConfig } from "axios"
import { createClient, type Adapter } from "openapi-shape/client"
import type { Endpoints } from "./api"

type AdapterOptions = Omit<AxiosRequestConfig, "method" | "url" | "data" | "headers">

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  const response = await axios.request({ ...options, method, url, data: body, headers })
  return response.data
}

export const api = createClient<Endpoints, AdapterOptions>(adapter)
```

</details>

<details>
<summary>ky adapter</summary>

```ts
import ky, { type Options as KyOptions } from "ky"
import { createClient, type Adapter } from "openapi-shape/client"
import type { Endpoints } from "./api"

type AdapterOptions = Omit<KyOptions, "method" | "body" | "headers">

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  return ky(url, { ...options, method, body, headers }).json()
}

export const api = createClient<Endpoints, AdapterOptions>(adapter)
```

</details>

<details>
<summary>ofetch adapter</summary>

```ts
import { ofetch, type FetchOptions } from "ofetch"
import { createClient, type Adapter } from "openapi-shape/client"
import type { Endpoints } from "./api"

type AdapterOptions = Omit<FetchOptions, "method" | "body" | "headers">

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  return ofetch(url, { ...options, method, body, headers })
}

export const api = createClient<Endpoints, AdapterOptions>(adapter)
```

</details>

### Typed Query Keys

The generated `Endpoints` map can also type cache keys for libraries such as TanStack Query. `openapi-shape` does not generate hooks; keep cache policy, invalidation, and optimistic updates in your app.

<details>
<summary>TanStack Query example</summary>

```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import type { Endpoints } from "./api"
import { api } from "./client"

type NonNullish = NonNullable<unknown>
type EmptyObject = Record<PropertyKey, never>
type HasOnlyOptionalProps<T> = T extends object ? (NonNullish extends T ? true : false) : false

type QueryKeyEndpoint = keyof Endpoints & string

type QueryKeyParamsPart<K extends QueryKeyEndpoint> = Endpoints[K]["params"] extends void
  ? NonNullish
  : { params: Endpoints[K]["params"] }

type QueryKeyQueryPart<K extends QueryKeyEndpoint> = Endpoints[K]["query"] extends void
  ? NonNullish
  : HasOnlyOptionalProps<Endpoints[K]["query"]> extends true
    ? { query?: Endpoints[K]["query"] }
    : { query: Endpoints[K]["query"] }

type QueryKeyInput<K extends QueryKeyEndpoint> = QueryKeyParamsPart<K> & QueryKeyQueryPart<K>

type QueryKeyArgs<K extends QueryKeyEndpoint> = keyof QueryKeyInput<K> extends never
  ? [input?: EmptyObject]
  : NonNullish extends QueryKeyInput<K>
    ? [input?: QueryKeyInput<K>]
    : [input: QueryKeyInput<K>]

export const apiKeys = {
  /** Endpoint-level key for broad invalidation, e.g. all GET /pets queries. */
  endpoint: <K extends QueryKeyEndpoint>(endpoint: K) => [endpoint] as const,
  /** Request-level key including params/query input for exact query caching. */
  request: <K extends QueryKeyEndpoint>(endpoint: K, ...[input]: QueryKeyArgs<K>) =>
    input === undefined ? ([endpoint] as const) : ([endpoint, input] as const),
}

export function usePets(limit?: number) {
  const query = limit === undefined ? {} : { limit }

  return useQuery({
    queryKey: apiKeys.request("GET /pets", { query }),
    queryFn: () => api("GET /pets", { query }),
  })
}

export function useCreatePet() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (body: Endpoints["POST /pets"]["body"]) => api("POST /pets", { body }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: apiKeys.endpoint("GET /pets"),
      })
    },
  })
}
```

</details>

## Programmatic API

Use the generator directly from build scripts, custom CLIs, or tests:

```ts
import { generate } from "openapi-shape"
import { writeFile } from "node:fs/promises"

const code = await generate("./openapi.json", {
  headers: true,
  formats: { "date-time": "Date", "uuid": "string" },
})

await writeFile("src/api.d.ts", code)
```

`generate(source)` is async for file paths and URLs. `generate(doc)` is synchronous for already-parsed OpenAPI objects:

```ts
import { generate } from "openapi-shape"

const code = generate(openapi)
```

Options:

| Option    | Default | Description                                                                                                                                                                                                   |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formats` | `{}`    | Maps OpenAPI `format` values to raw TypeScript expressions. Applies to `string`, `number`, and `integer` schemas, including nullable variants. User mappings override the built-in `binary`/`byte` -> `Blob`. |
| `headers` | `false` | Adds a typed `headers` field to each endpoint, webhook, and callback from `in: header` parameters. When false, callers may still pass arbitrary runtime headers through the client.                              |

## OpenAPI Support

`openapi-shape` supports a focused subset of OpenAPI 3.0.x and 3.1.x. It reads JSON or YAML and generates types for operations, callbacks, reusable schemas, and OpenAPI 3.1 webhooks; it is not a full OpenAPI or JSON Schema implementation.

### Documents and operations

| Feature                 | Generated behavior                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paths and HTTP methods  | `get`, `put`, `post`, `delete`, `options`, `head`, `patch`, and `trace` operations become `"METHOD /path"` entries in `Endpoints`.                                                                                                                         |
| Parameters              | Path parameters are required strings. Query parameters retain their schema types and requiredness. Header parameters become strings when generation uses `headers: true` or `--headers`. Cookie parameters are ignored.                                    |
| Request bodies          | JSON-family media types are preferred, followed by the first media type with a schema. `requestBody.required: true` emits `body: T`; otherwise it emits `body?: T`. An absent or schema-less body emits `body: void`.                                      |
| Responses               | OpenAPI response keys are preserved, including `"200"`, `"4XX"`, and `"default"`. Selection prefers JSON-family content with a schema, followed by binary (`Blob`), text (`string`), and then the first other schema-bearing media type. If content exists but none of its media types has a schema, the first entry becomes `Blob`; a response without content becomes `void`. |
| Missing responses       | OpenAPI 3.0 operations must declare `responses`. In OpenAPI 3.1, a missing or empty response map emits `response: unknown`.                                                                                                                                |
| OpenAPI 3.1 `webhooks`  | Webhook operations become entries in a parallel `Webhooks` interface, using `payload` for the incoming body and `reply` for responses.                                                                                                                     |
| Callbacks               | Inline callbacks and local `components.callbacks` references become entries in a parallel `Callbacks` interface, using receiving-side `payload` and `reply` fields.                                                                                        |
| Local component `$ref`s | Local references to component path items, parameters, request bodies, responses, and callbacks are resolved before generation. Schema references are validated and remain named `Schemas.*` references.                                                    |
| Documentation metadata  | Document info, operation/schema/property descriptions, summaries, and deprecation markers are retained where they map to the generated declaration.                                                                                                        |

### Schemas

| Feature                    | TypeScript output                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components.schemas`       | Named declarations under `export namespace Schemas`. Simple object models become `interface`s; aliases, primitives, unions, and composed schemas become `type`s.                                                                |
| Primitive and object types | `string`, `number`/`integer`, `boolean`, `null`, object properties, and required properties map to their TypeScript equivalents. Boolean schemas map `true` to `unknown` and `false` to `never`.                                |
| `enum` / `const`           | Primitive values become literal types and literal unions. Empty enums become `never`; unsupported literal values become `unknown`.                                                                                              |
| `oneOf` / `anyOf`          | Approximated as deduplicated TypeScript unions. TypeScript does not preserve `oneOf` exclusivity.                                                                                                                               |
| `allOf`                    | TypeScript intersections. Meaningful sibling constraints beside `allOf`, `oneOf`, or `anyOf` are retained as an additional intersection member.                                                                                 |
| `discriminator`            | For component `$ref` branches, required string literals are injected and explicit mappings are honored. Inline branches are accepted; an existing single-string `const` or `enum` discriminator is made required for narrowing. |
| OpenAPI 3.0 `nullable`     | Typed nullable schemas become an explicit union with `null`, retaining constraints such as `enum` and composition.                                                                                                              |
| OpenAPI 3.1 type arrays    | `type: ["T", "null"]` and other type arrays become TypeScript unions. An `enum` remains authoritative, so `null` is included only when it appears in the enum.                                                                  |
| Arrays and tuples          | Schema-valued `items` becomes an array element type. `prefixItems` becomes a tuple head, with an optional rest element derived from `items`; `items: true` produces an `unknown` rest element.                                  |
| `additionalProperties`     | `true` produces an `unknown` index signature. Schema-valued entries use `T`; dictionary-only objects become `Record<string, T>`, while declared objects receive a compatible index signature.                                   |
| `patternProperties`        | Pattern value schemas are folded into a string index signature. When multiple patterns exist, their value types become a union; regular-expression key constraints are not preserved by TypeScript.                             |
| Formats                    | `binary` and `byte` map to `Blob`. The programmatic `formats` option can map other string, number, or integer formats to custom TypeScript expressions.                                                                         |

### Identifier handling

- Invalid object property and parameter names are quoted, for example `"user-id"?: string`.
- Invalid or reserved schema names are sanitized, for example `User-Profile` -> `User_Profile` and `class` -> `_class`.
- Schema name collisions after sanitization throw an error.

## Limitations

- Swagger 2.0. Convert to OpenAPI 3 first.
- OpenAPI 3.2.
- `readOnly` / `writeOnly` request and response variants.
- External `$ref` targets such as remote URLs or separate files.
- Non-component discriminator `$ref` branches. Inline branches without an existing single-string `const` or `enum` are preserved but cannot be augmented with an inferred discriminator value.
- Cookie parameters (`in: cookie`). They are parsed but not emitted.
- Response headers and reusable `components.headers`.
- Parameter `content`; parameters must provide a `schema` to contribute a generated type.
- Parameter serialization keywords such as `style`, `explode`, and `allowReserved`.
- `additionalProperties: false` cannot enforce exact object types under TypeScript's structural type system.
- Without `prefixItems`, boolean `items: false` is currently approximated as `unknown[]` rather than an element-free array.
- Path parameters declared on callback path items are not represented in callback entries; query parameters and optionally generated headers are retained.
- Callbacks nested inside callback operations.
- OpenAPI sections that do not contribute to generated declarations, including `servers`, `security`, `securitySchemes`, `links`, and `examples`.
- JSON Schema keywords outside the supported feature table, such as `not`, `if`/`then`/`else`, and `unevaluatedProperties`.

## License

[MIT](./LICENSE) License

[npm-version-src]: https://img.shields.io/npm/v/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmx.dev/package/openapi-shape
[npm-downloads-src]: https://img.shields.io/npm/dm/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmx.dev/package/openapi-shape
[bundle-src]: https://img.shields.io/bundlephobia/minzip/openapi-shape?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=openapi-shape
[license-src]: https://img.shields.io/github/license/usings/openapi-shape.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/usings/openapi-shape/blob/main/LICENSE
