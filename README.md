# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Node.js][node-src]][node-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]

Generate compact TypeScript API contracts from OpenAPI 3.0/3.1 JSON or YAML—without generating an entire SDK.

- **Predictable types:** operations, schemas, webhooks, and callbacks stay aligned with your OpenAPI document.
- **Bring your own client:** use the declarations directly or pair them with the optional transport-agnostic client.
- **CI-friendly:** generate from a local file or URL and detect stale output with `--check`.

## Contents

- [Quick Start](#quick-start)
- [Generated Types](#generated-types)
- [CLI](#cli)
- [Typed Client (Optional)](#typed-client-optional)
- [Programmatic API](#programmatic-api)
- [OpenAPI Support](#openapi-support)
- [Limitations](#limitations)

## Quick Start

### Install

Install `openapi-shape` as a development dependency when you only generate declarations during development or CI:

```sh
pnpm add -D openapi-shape
```

If deployed code imports `openapi-shape/client`, install it as a regular dependency with `pnpm add openapi-shape` instead.

### Generate

Generate declarations from a local JSON/YAML file or an HTTP(S) URL:

```sh
pnpm exec openapi-shape ./openapi.yaml -o src/api.d.ts
```

Commit the generated file, or append `--check` in CI to verify that it is up to date without modifying it.

### Use the generated types

Import the generated declarations directly—no runtime import from `openapi-shape` is required:

```ts
import type { Endpoints, Schemas } from "./api"

type ListPetsQuery = Endpoints["GET /pets"]["query"]
type ListPetsResponse = Endpoints["GET /pets"]["response"]["200"]
type Pet = Schemas.Pet
```

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
- `query` (plus `headers` with `--headers` and `cookies` with `--cookies`) describes what the third party sends.

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
    params: void
    query: void
    payload: Schemas.Event
    reply: { "204": void }
  }
}
```

Callback entries use the same receiving-side `payload` and `reply` vocabulary as webhooks, plus `params` for path parameters declared on the callback path item. Inline callbacks and local references to `components.callbacks` are supported. Callbacks nested inside callback operations are flattened beside their parents with chained keys; a chain stops if the same callback object repeats within it.

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
| `--cookies`           | Generate typed `cookies` fields from OpenAPI `in: cookie` parameters. |

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

This minimal adapter expects JSON success bodies and returns `undefined` for empty responses:

```ts
import { createClient, type Adapter } from "openapi-shape/client"
import type { Endpoints } from "./api"

const adapter: Adapter = async ({ method, url, body, headers }) => {
  const response = await fetch(url, { method, body, headers })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)

  if (method === "HEAD" || response.status === 204 || response.status === 205) return undefined
  const text = await response.text()
  return text === "" ? undefined : JSON.parse(text)
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

### Request Building

The optional client builds adapter input with these rules:

| Field     | Behavior                                                                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`  | Read from the endpoint key, such as `GET /pets`.                                                                                                                                                                                                                                   |
| `url`     | `baseURL` plus path params and query string. Path params are URL-encoded. Query arrays become repeated keys, for example `tags=a&tags=b`. `null` and `undefined` query values are skipped. Absolute `http://` and `https://` endpoint paths bypass `baseURL`.                      |
| `body`    | `undefined` stays `undefined`. `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`, `ArrayBuffer` views (including typed arrays and `DataView`), and `ReadableStream` pass through unchanged. Other defined bodies — including strings — are JSON-stringified.                    |
| `headers` | Client-level defaults are merged before body-derived headers and per-call headers. JSON bodies get `content-type: application/json`; passthrough bodies get no automatic content type. Later values override earlier ones case-insensitively. Adapter headers use lowercase names. |
| `options` | Passed through to your adapter after default/per-call merging. Object options are shallow-merged; non-object options are replaced by the per-call value.                                                                                                                           |

OpenAPI request media types inform the generated body type, but they do not configure runtime serialization. Customize serialization when your API does not use the defaults above—for example, media types such as `text/plain` that need different encoding:

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

### Integration Examples

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
  if (
    method === "HEAD" ||
    response.status === 204 ||
    response.status === 205 ||
    contentLength === "0"
  ) {
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
| `headers` | `false` | Adds a typed `headers` field to each endpoint, webhook, and callback from `in: header` parameters. When false, callers may still pass arbitrary runtime headers through the client.                           |
| `cookies` | `false` | Adds a typed `cookies` field to each endpoint, webhook, and callback from `in: cookie` parameters. Cookie fields retain their schema types; the client never sends cookies itself.                            |

## OpenAPI Support

`openapi-shape` supports a focused subset of OpenAPI 3.0.x and 3.1.x. It converts
API operations and reusable schemas into TypeScript declarations; it does not
validate the complete OpenAPI or JSON Schema specifications.

### Compatibility at a glance

| Area                 | Support                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| Versions             | OpenAPI 3.0.x and 3.1.x. Documents without `openapi` are treated as 3.1-style input. |
| Sources              | Parsed objects, local paths, `file:` URLs, and HTTP(S) URLs.                         |
| Formats              | JSON and YAML. Unknown file extensions try JSON first, then YAML.                    |
| Operations           | Paths, OpenAPI 3.1 webhooks, and callbacks.                                          |
| HTTP methods         | `get`, `put`, `post`, `delete`, `options`, `head`, `patch`, and `trace`.             |
| Reusable schemas     | Local `components.schemas` entries and references.                                   |
| Component references | Local path item, parameter, request body, response, and callback references.         |
| Metadata             | Document info, descriptions, summaries, and deprecation markers where applicable.    |

### Generated declarations

| OpenAPI source         | TypeScript declaration | Entry shape                                                            |
| ---------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `paths`                | `Endpoints`            | `"METHOD /path"` with `params`, `query`, `body`, and `response`.       |
| OpenAPI 3.1 `webhooks` | `Webhooks`             | `"METHOD name"` with `query`, `payload`, and `reply`.                  |
| Operation `callbacks`  | `Callbacks`            | A chained callback key with `params`, `query`, `payload`, and `reply`. |
| `components.schemas`   | `Schemas` namespace    | Named interfaces and type aliases used by operation declarations.      |

### Operation rules

#### Parameters

| Location | Generated behavior                                                     |
| -------- | ---------------------------------------------------------------------- |
| Path     | Required `string` fields under `params`.                               |
| Query    | Schema-derived fields under `query`, preserving requiredness.          |
| Header   | Opt-in `string` fields under `headers`.                                |
| Cookie   | Opt-in schema-derived fields under `cookies`, preserving requiredness. |

Operation-level parameters replace path-level parameters with the same `in` and
`name`. A parameter declared with `content` uses its media type schema when
`schema` is absent.

#### Request bodies

A request body selects the first JSON-family media type with a schema, then the
first remaining media type with a schema. JSON-family means a `json` or `+json`
subtype.

- `requestBody.required: true` becomes `body: T` for endpoints or `payload: T` for
  webhooks and callbacks.
- An optional request body becomes `body?: T` or `payload?: T`.
- A missing or schema-less request body becomes `body: void` or `payload: void`.

#### Responses

Response keys are preserved exactly as declared, including `"200"`, `"4XX"`, and
`"default"`. One media type is selected for each response in this order:

1. A JSON-family media type with a schema.
2. Binary content or a `binary` / `byte` schema, emitted as `Blob`.
3. Text content, using its schema or `string` when schema-less.
4. The first remaining media type with a schema.
5. The first schema-less media type, emitted as `Blob`.

A response without content becomes `void`. OpenAPI 3.0 operations must declare
`responses`. For OpenAPI 3.1-style input, a missing or empty response map becomes
`response: unknown` or `reply: unknown`.

### Schema mapping

Named schemas are emitted under `export namespace Schemas`. A schema with an
explicit object type and properties becomes an `interface`; other schemas become
type aliases.

| OpenAPI schema feature    | TypeScript output                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Primitive types           | `string`, `number` / `integer`, `boolean`, and `null`.                                                         |
| Object properties         | Object fields with OpenAPI `required` reflected as required TypeScript properties.                             |
| Boolean schemas           | `true` becomes `unknown`; `false` becomes `never`.                                                             |
| `enum` / `const`          | Primitive literals and unions; an empty enum becomes `never`, and unsupported literal values become `unknown`. |
| `oneOf` / `anyOf`         | Deduplicated TypeScript unions.                                                                                |
| `allOf`                   | TypeScript intersections.                                                                                      |
| Composition siblings      | Meaningful sibling constraints become an additional intersection member.                                       |
| OpenAPI 3.0 `nullable`    | An explicit union with `null`, retaining enum and composition constraints.                                     |
| OpenAPI 3.1 type arrays   | TypeScript unions; an `enum` remains authoritative when present.                                               |
| `items`                   | An array element type; missing or unconstrained items become `unknown`.                                        |
| `prefixItems`             | A tuple head, optionally followed by a rest type derived from `items`.                                         |
| `items: false`            | An empty tuple without `prefixItems`; otherwise no tuple rest element.                                         |
| `additionalProperties`    | A `Record` or compatible index signature; `true` uses `unknown` values.                                        |
| `patternProperties`       | A string index signature whose value is the union of the pattern schemas.                                      |
| `binary` / `byte` formats | `Blob`.                                                                                                        |
| Custom formats            | User-provided TypeScript expressions for string, number, and integer formats.                                  |

For discriminated `oneOf` and `anyOf` unions, local component `$ref` branches
receive required string literals and explicit mappings are honored. An inline
branch is narrowable when it already declares a single string `const` or
single-value `enum` for the discriminator property.

### References and validation

Local component references to path items, parameters, request bodies, responses,
and callbacks are resolved before generation. Schema references remain named
`Schemas.*` references and must point directly to an existing
`components.schemas` entry.

Generation fails for:

- Unsupported document versions.
- Missing reference targets or references to the wrong component section.
- External, nested, or otherwise unsupported schema references.
- Circular non-schema component references.
- Conflicting or invalid discriminator injections.
- Schema names that collide after identifier sanitization.
- OpenAPI 3.0 operations without `responses`.

Invalid property and parameter names are quoted, for example
`"user-id"?: string`. Invalid or reserved schema names are sanitized, for example
`User-Profile` becomes `User_Profile` and `class` becomes `_class`.

## Limitations

### Unsupported inputs

- Swagger 2.0 and OpenAPI 3.2.
- External `$ref` targets such as remote URLs or separate files.
- Schema `$ref`s to nested values or component sections other than
  `components.schemas`.

### Ignored features

These fields do not affect the generated declarations:

- `readOnly` / `writeOnly` request and response variants.
- Response headers and reusable `components.headers`.
- Parameter serialization keywords such as `style`, `explode`, and `allowReserved`.
- `servers`, `security`, `securitySchemes`, `links`, and `examples`.
- JSON Schema keywords such as `not`, `if` / `then` / `else`, and
  `unevaluatedProperties`.

### TypeScript approximations

- `oneOf` becomes a union, but TypeScript cannot preserve its exclusivity.
- `additionalProperties: false` cannot enforce exact object types.
- `patternProperties` value types are preserved, but regular-expression key
  constraints are not.
- Non-component discriminator references cannot receive inferred discriminator
  values.

## License

[MIT](./LICENSE) License

[npm-version-src]: https://img.shields.io/npm/v/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmx.dev/package/openapi-shape
[npm-downloads-src]: https://img.shields.io/npm/dm/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmx.dev/package/openapi-shape
[node-src]: https://img.shields.io/node/v/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[node-href]: https://nodejs.org
[bundle-src]: https://img.shields.io/bundlephobia/minzip/openapi-shape?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=openapi-shape
[license-src]: https://img.shields.io/github/license/usings/openapi-shape.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/usings/openapi-shape/blob/main/LICENSE
