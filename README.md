# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]

Generate TypeScript declarations and endpoint shapes from OpenAPI JSON.

`openapi-shape` turns an OpenAPI 3.x JSON document into TypeScript declarations: named schema types plus an `Endpoints` map for each route's params, query, request body, and response.

Use it when OpenAPI is your type contract, but your app should still own the HTTP layer.

- Emits `.d.ts` files.
- Preserves schemas as named TypeScript types.
- Generates an `Endpoints` map keyed by `"METHOD /path"`.
- Offers an optional adapter-based client for typed calls.
- Avoids generating a full SDK or owning your network stack.

Requires Node >= 18 and TypeScript >= 5.

## Install

Install as a dev dependency if you only generate declarations:

```sh
pnpm add -D openapi-shape
```

Install as a runtime dependency if you use `createClient` in application code:

```sh
pnpm add openapi-shape
```

Using npm or yarn? Replace `pnpm add` with `npm install` or `yarn add`.

## Generate Types

From a local OpenAPI JSON file:

```sh
pnpm exec openapi-shape ./openapi.json -o src/api.d.ts
```

From a URL:

```sh
pnpm exec openapi-shape https://api.example.com/openapi.json -o src/api.d.ts
```

Add a package script if you regenerate declarations often:

```json
{
  "scripts": {
    "gen:api": "openapi-shape ./openapi.json -o src/api.d.ts"
  }
}
```

## What You Get

The generated file is plain TypeScript declarations.

```ts
export interface Endpoints {
  "GET /pets": {
    params: void;
    query: { limit?: number };
    body: void;
    response: Pet[];
  };
  "POST /pets": {
    params: void;
    query: void;
    body: CreatePet;
    response: Pet;
  };
  "GET /pets/{petId}": {
    params: { petId: string };
    query: void;
    body: void;
    response: Pet;
  };
}

export interface Pet {
  id: number;
  name: string;
}

export interface CreatePet {
  name: string;
}
```

`void` means the endpoint has no value for that slot. If you only need a type boundary between your API spec and your app, this is the whole workflow.

## Optional Typed Client

`createClient<Endpoints>(adapter)` gives you one typed request function. TypeScript checks the endpoint key, path params, query, body, and response type at compile time.

It is intentionally not a fetch wrapper. Your adapter still owns auth, retries, error handling, response parsing, and the HTTP library.

```ts
// src/api-client.ts
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

const adapter: Adapter = async ({ method, url, body, headers }) => {
  const response = await fetch(url, { method, body, headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
};

export const api = createClient<Endpoints>(adapter, {
  baseURL: "https://api.example.com",
});
```

Call it from application code:

```ts
import { api } from "./api-client";

const pets = await api("GET /pets", {
  query: { limit: 10 },
});

const pet = await api("GET /pets/{petId}", {
  params: { petId: "1" },
});

const created = await api("POST /pets", {
  body: { name: "Buddy" },
});
```

## Adapter Options

Each call may pass `headers` and `options`.

```ts
await api("GET /pets", {
  query: { limit: 10 },
  headers: { "X-Trace-Id": "abc" },
  options: { timeout: 5000 },
});
```

- `headers` are merged after automatic headers, so caller values win.
- `options` is passed to the adapter unchanged.
- `Adapter<TOptions>` makes `options` typed for axios, ky, ofetch, or your own client.
- Omit fields owned by the adapter (`method`, `url`, `body`/`data`, `headers`) from `TOptions` so callers cannot override them.

<details>
<summary>Adapter examples for axios, ky, and ofetch</summary>

Axios:

```ts
import axios, { type AxiosRequestConfig } from "axios";
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

type AdapterOptions = Omit<AxiosRequestConfig, "method" | "url" | "data" | "headers">;

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  const response = await axios.request({ method, url, data: body, headers, ...options });
  return response.data;
};

export const api = createClient<Endpoints, AdapterOptions>(adapter);
```

ky:

```ts
import ky, { type Options as KyOptions } from "ky";
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

type AdapterOptions = Omit<KyOptions, "method" | "body" | "headers">;

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  return ky(url, { method, body, headers, ...options }).json();
};

export const api = createClient<Endpoints, AdapterOptions>(adapter);
```

ofetch:

```ts
import { ofetch, type FetchOptions } from "ofetch";
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

type AdapterOptions = Omit<FetchOptions, "method" | "body" | "headers">;

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  return ofetch(url, { method, body, headers, ...options });
};

export const api = createClient<Endpoints, AdapterOptions>(adapter);
```

</details>

## Request Building

The optional client builds adapter input like this:

| Field | Behavior |
| --- | --- |
| `method` | Read from the endpoint key, such as `GET /pets`. |
| `url` | `baseURL` plus path params and query string. Path params are URL-encoded. Query arrays become repeated keys, for example `tags=a&tags=b`. `null` and `undefined` query values are skipped. |
| `body` | `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`, typed arrays, and `ReadableStream` pass through unchanged. `undefined` stays `undefined`. Everything else is `JSON.stringify`-ed. |
| `headers` | JSON bodies get `Content-Type: application/json`. Passthrough bodies get no automatic content type. Per-call headers override automatic headers. |
| `options` | Passed through to your adapter without inspection. |

For multipart requests, keep any cast close to the wrapper that knows the endpoint:

```ts
import { api } from "./api-client";
import type { Endpoints } from "./api";

export function uploadPetPhoto(file: File) {
  const form = new FormData();
  form.append("file", file);

  return api("POST /upload", {
    body: form as Endpoints["POST /upload"]["body"],
  });
}
```

<details>
<summary>Production fetch adapter</summary>

```ts
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly response: Response,
  ) {
    super(`HTTP ${status} ${response.statusText}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

const adapter: Adapter = async ({ method, url, body, headers }) => {
  const response = await fetch(url, {
    method,
    body,
    headers: { ...headers, Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text(), response);
  }

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (/^application\/(.*\+)?json/.test(contentType)) return response.json();
  if (contentType.startsWith("text/")) return response.text();
  return response.blob();
};

export const api = createClient<Endpoints>(adapter, {
  baseURL: "https://api.example.com",
});
```

</details>

## Programmatic API

Use the generator from build scripts or tests:

```ts
import { generate, generateFromSource } from "openapi-shape";
import { writeFile } from "node:fs/promises";

const code = await generateFromSource("./openapi.json");
await writeFile("src/api.d.ts", code);
```

`generate(doc)` is synchronous and accepts an already-parsed object:

```ts
import { generate } from "openapi-shape";

const code = generate(openapi);
```

### Options

Both `generate` and `generateFromSource` accept options:

```ts
await generateFromSource("./openapi.json", {
  formats: { "date-time": "Date", "uuid": "UUID" },
  errors: true,
  header: false,
});
```

| Option | Default | Description |
| --- | --- | --- |
| `formats` | `{}` | Maps OpenAPI `format` values to custom TypeScript types. Applies to schemas with `type: "string" \| "number" \| "integer"` and nullable variants such as `["string", "null"]`. User mappings override the built-in `binary`/`byte` -> `Blob`. |
| `errors` | `false` | Adds an `errors` field to each endpoint type with collected 4xx/5xx response types, including `4XX`/`5XX` wildcards. `default` responses are not collected. The runtime client does not consume this field. |
| `header` | default | Pass `false` to omit the generated JSDoc header, or a function `(info) => string` to replace it. |

### Advanced API

For finer control, use the pipeline directly:

```ts
import { loadDocument, prepareDocument, buildIR, render } from "openapi-shape";

// File / URL → prepared OpenAPI document
const doc = await loadDocument("./openapi.json");

// In-memory raw object → prepared document (sync)
const doc2 = prepareDocument(rawObject);

// Prepared document → intermediate representation
const ir = buildIR(doc, { formats: { "date-time": "Date" } });

// IR → TypeScript string
const code = render(ir, { errors: true });
```

`OpenAPIDocument`, `IR`, `TypeNode`, and the rest of the IR types are exported. `LoadError` (read, parse, unsupported version) and `BuildError` (schema name collision, discriminator conflict) are exported for `instanceof` checks.

## Supported

OpenAPI 3.0 and 3.1 JSON documents.

| Feature | Output |
| --- | --- |
| `components.schemas` | `export interface` or `export type` declarations. |
| `$ref` schemas | Named TypeScript references. |
| `$ref` parameters, request bodies, responses, path items | Resolved before endpoint generation. |
| `oneOf` / `anyOf` / `allOf` | Union / union / intersection types. |
| `discriminator` on `oneOf` / `anyOf` | Discriminator literals injected into branches for narrowable unions, including `allOf` branch schemas. |
| `enum` / `const` | Literal types. |
| OpenAPI 3.0 `nullable` | Adds `null`. |
| OpenAPI 3.1 `type: ["T", "null"]` | Adds `null`. |
| `prefixItems` | Tuple types, with optional rest from `items`. |
| `additionalProperties` | `Record<string, T>` or explicit properties plus an index signature. |
| `requestBody.required` | Missing or `false` means `body?: T`; `true` means `body: T`. |
| 2xx responses | JSON schema -> typed response, `text/*` -> `string`, binary -> `Blob`, empty success -> `void`, otherwise `unknown`. |

Identifier handling:

- Invalid object property and parameter names are quoted, for example `"user-id"?: string`.
- Invalid or reserved schema names are sanitized, for example `User-Profile` -> `User_Profile` and `class` -> `_class`.
- Schema name collisions after sanitization throw an error.

## Not Supported Yet

- Swagger 2.0. Convert to OpenAPI 3 first.
- YAML input.
- `readOnly` / `writeOnly` request and response variants.
- External `$ref` targets such as remote URLs or separate files.

## License

[MIT](./LICENSE) License

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmx.dev/package/openapi-shape
[npm-downloads-src]: https://img.shields.io/npm/dm/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmx.dev/package/openapi-shape
[bundle-src]: https://img.shields.io/bundlephobia/minzip/openapi-shape?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=openapi-shape
[license-src]: https://img.shields.io/github/license/usings/openapi-shape.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/usings/openapi-shape/blob/main/LICENSE
