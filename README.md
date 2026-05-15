# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![License][license-src]][license-href]

Generate TypeScript declarations from OpenAPI 3.x JSON, plus optional typed request shapes for your own HTTP client.

Use `openapi-shape` when OpenAPI is your type contract, but your app should still own fetch/axios/ky/ofetch, auth, retries, caching, and response parsing.

## Quick Start

Run without installing:

```sh
npx openapi-shape ./openapi.json -o src/api.d.ts
```

Generate from a URL:

```sh
npx openapi-shape https://api.example.com/openapi.json -o src/api.d.ts
```

Install in a project when you regenerate types often:

```sh
pnpm add -D openapi-shape
pnpm exec openapi-shape ./openapi.json -o src/api.d.ts
```

Install as a runtime dependency only if you use the optional client:

```sh
pnpm add openapi-shape
```

Requires Node >= 22 and TypeScript >= 5.

## What It Generates

The generated file is plain TypeScript declarations:

```ts
export interface Endpoints {
  "GET /pets": {
    params: void;
    query: { limit?: number };
    body: void;
    response: Schemas.Pet[];
  };
  "POST /pets": {
    params: void;
    query: void;
    body: Schemas.CreatePet;
    response: Schemas.Pet;
  };
  "GET /pets/{petId}": {
    params: { petId: string };
    query: void;
    body: void;
    response: Schemas.Pet;
  };
}

export namespace Schemas {
  export interface Pet {
    id: number;
    name: string;
  }

  export interface CreatePet {
    name: string;
  }
}
```

Key ideas:

- `Endpoints` is keyed by `"METHOD /path"`.
- Each endpoint has `params`, `query`, `body`, and `response`.
- OpenAPI `components.schemas` are grouped under `Schemas`.
- `void` means that slot has no value.
- The file is safe to commit or regenerate in CI.

### Webhooks

OpenAPI 3.1 `webhooks` are emitted as a parallel `Webhooks` interface:

```ts
export interface Webhooks {
  "POST pet.created": {
    query: void;
    payload: Schemas.Pet;
    reply: void;
  };
}
```

Webhook entries use the receiving side's vocabulary:

- `payload` is the incoming request body.
- `reply` is the handler's outgoing response.
- `params` is omitted because webhook names do not have URL templates.
- `query`, `headers`, and `errors` describe what the third party sends and what your handler returns.

Example handler type:

```ts
import type { Webhooks } from "./api";

function onPetCreated(payload: Webhooks["POST pet.created"]["payload"]) {
  payload.id;
}
```

## CLI

```text
USAGE openapi-shape [OPTIONS] <SOURCE> --output=<output>

ARGUMENTS

  SOURCE    Path to OpenAPI JSON file or HTTP(S) URL

OPTIONS

  -o, --output=<output>    Output file path
                --check    Exit non-zero if --output is missing or stale
              --headers    Emit typed header parameters per endpoint/webhook
               --errors    Emit typed 4xx/5xx response maps
```

Typical package script:

```json
{
  "scripts": {
    "gen:api": "openapi-shape ./openapi.json -o src/api.d.ts",
    "check:api": "openapi-shape ./openapi.json -o src/api.d.ts --check"
  }
}
```

## Optional Client

`openapi-shape/client` gives you one typed request function over the generated `Endpoints` map. It builds `method`, `url`, `body`, and `headers`; your adapter still owns the actual HTTP call.

```ts
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

const adapter: Adapter = async ({ method, url, body, headers }) => {
  const response = await fetch(url, { method, body, headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  if (response.status === 204) return undefined;
  return response.json();
};

export const api = createClient<Endpoints>(adapter, {
  baseURL: "https://api.example.com",
});
```

Calls are checked at compile time:

```ts
const pets = await api("GET /pets", {
  query: { limit: 10 },
});

const created = await api("POST /pets", {
  body: { name: "Buddy" },
});
```

Adapter-specific options stay typed and pass through to your adapter:

```ts
type AdapterOptions = { timeout?: number };

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeout ?? 30_000);
  try {
    const response = await fetch(url, { method, body, headers, signal: controller.signal });
    return response.status === 204 ? undefined : response.json();
  } finally {
    clearTimeout(timeout);
  }
};

export const api = createClient<Endpoints, AdapterOptions>(adapter, {
  options: { timeout: 5000 },
});

await api("GET /pets", {
  query: { limit: 10 },
  options: { timeout: 1000 },
});
```

A fuller fetch adapter uses the same contract. Put application-specific behavior, such as auth and response parsing, inside the adapter:

<details>
<summary>More complete fetch adapter</summary>

This version handles auth headers, typed HTTP errors, empty responses, and content-type based parsing.

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

declare function getToken(): string;

const adapter: Adapter = async ({ method, url, body, headers }) => {
  const response = await fetch(url, {
    method,
    body,
    headers: { ...headers, authorization: `Bearer ${getToken()}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new HttpError(response.status, errorBody, response);
  }

  const contentLength = response.headers.get("content-length");
  if (response.status === 204 || contentLength === "0") {
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

For third-party adapters, use `Omit<...>` so callers cannot override fields owned by the generated request (`method`, `url`, `body`/`data`, `headers`).

These examples focus on mapping `openapi-shape` adapter input to each library. Add auth, retries, hooks, and error handling with the HTTP client's own APIs.

<details>
<summary>axios adapter</summary>

```ts
import axios, { type AxiosRequestConfig } from "axios";
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

type AdapterOptions = Omit<AxiosRequestConfig, "method" | "url" | "data" | "headers">;

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  const response = await axios.request({ ...options, method, url, data: body, headers });
  return response.data;
};

export const api = createClient<Endpoints, AdapterOptions>(adapter);
```

</details>

<details>
<summary>ky adapter</summary>

```ts
import ky, { type Options as KyOptions } from "ky";
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

type AdapterOptions = Omit<KyOptions, "method" | "body" | "headers">;

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  return ky(url, { ...options, method, body, headers }).json();
};

export const api = createClient<Endpoints, AdapterOptions>(adapter);
```

</details>

<details>
<summary>ofetch adapter</summary>

```ts
import { ofetch, type FetchOptions } from "ofetch";
import { createClient, type Adapter } from "openapi-shape/client";
import type { Endpoints } from "./api";

type AdapterOptions = Omit<FetchOptions, "method" | "body" | "headers">;

const adapter: Adapter<AdapterOptions> = async ({ method, url, body, headers, options }) => {
  return ofetch(url, { ...options, method, body, headers });
};

export const api = createClient<Endpoints, AdapterOptions>(adapter);
```

</details>

## Request Building

The optional client builds adapter input with these rules:

| Field     | Behavior                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`  | Read from the endpoint key, such as `GET /pets`.                                                                                                                                                                                                              |
| `url`     | `baseURL` plus path params and query string. Path params are URL-encoded. Query arrays become repeated keys, for example `tags=a&tags=b`. `null` and `undefined` query values are skipped. Absolute `http://` and `https://` endpoint paths bypass `baseURL`. |
| `body`    | `undefined` stays `undefined`. `string`, `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`, typed arrays, and `ReadableStream` pass through unchanged. Other defined bodies are JSON-stringified.                                                          |
| `headers` | JSON bodies get `content-type: application/json`. Passthrough bodies get no automatic content type. Per-call headers override automatic headers case-insensitively. Adapter headers use lowercase names.                                                      |
| `options` | Passed through to your adapter after default/per-call merging. Object options are shallow-merged; non-object options are replaced by the per-call value.                                                                                                      |

Customize serialization when your API does not use the defaults:

```ts
export const api = createClient<Endpoints>(adapter, {
  baseURL: "https://api.example.com",
  serializeQuery(query) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value == null) continue;
      params.set(name, Array.isArray(value) ? value.join(",") : String(value));
    }
    return params;
  },
  serializeBody(body) {
    if (typeof body === "string") {
      return { body, headers: { "Content-Type": "text/plain" } };
    }

    return {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    };
  },
});
```

- `serializeQuery` receives the raw query object and returns a query string or `URLSearchParams`.
- `serializeBody` receives each non-`undefined` body and returns the adapter body plus optional headers.
- Per-call headers still override headers returned by `serializeBody`.

## Programmatic API

Use the generator from build scripts, custom CLIs, or tests:

```ts
import { generate } from "openapi-shape";
import { writeFile } from "node:fs/promises";

const code = await generate("./openapi.json", {
  headers: true,
  errors: true,
  formats: { "date-time": "Date", uuid: "UUID" },
});

await writeFile("src/api.d.ts", code);
```

`generate(source)` is async for file paths and URLs. `generate(doc)` is synchronous for already-parsed OpenAPI objects:

```ts
import { generate } from "openapi-shape";

const code = generate(openapi);
```

Options:

| Option    | Default | Description                                                                                                                                                                                                                                           |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formats` | `{}`    | Maps OpenAPI `format` values to raw TypeScript type expressions. Applies to schemas with `type: "string" \| "number" \| "integer"` and nullable variants such as `["string", "null"]`. User mappings override the built-in `binary`/`byte` -> `Blob`. |
| `headers` | `false` | Adds a typed `headers` field to each endpoint/webhook from `in: header` parameters. When false, callers may still pass arbitrary runtime headers through the client.                                                                                  |
| `errors`  | `false` | Adds an `errors` field keyed by collected 4xx/5xx response status codes, including `4XX`/`5XX` wildcards. `default` responses are not collected. The runtime client does not consume this field.                                                      |

## Supported OpenAPI Features

OpenAPI 3.0 and 3.1 JSON documents are supported.

| Feature                                                  | Output                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `components.schemas`                                     | `export interface` or `export type` declarations inside `export namespace Schemas`.                                  |
| `$ref` schemas                                           | Named TypeScript references.                                                                                         |
| `$ref` parameters, request bodies, responses, path items | Resolved before endpoint generation.                                                                                 |
| `oneOf` / `anyOf` / `allOf`                              | Union / union / intersection types.                                                                                  |
| `discriminator` on `oneOf` / `anyOf`                     | Discriminator literals injected into branches for narrowable unions, including `allOf` branch schemas.               |
| `enum` / `const`                                         | Literal types.                                                                                                       |
| OpenAPI 3.0 `nullable`                                   | Adds `null`.                                                                                                         |
| OpenAPI 3.1 `type: ["T", "null"]`                        | Adds `null`.                                                                                                         |
| `prefixItems`                                            | Tuple types, with optional rest from `items`.                                                                        |
| `additionalProperties`                                   | `Record<string, T>` or explicit properties plus an index signature.                                                  |
| `patternProperties`                                      | Folded into the same index signature; multiple patterns become a union of value types.                               |
| OpenAPI 3.1 `webhooks`                                   | A parallel `Webhooks` interface with `payload` / `reply` entry fields.                                               |
| `requestBody.required`                                   | Missing or `false` means `body?: T`; `true` means `body: T`.                                                         |
| 2xx responses                                            | JSON schema -> typed response, `text/*` -> `string`, binary -> `Blob`, empty success -> `void`, otherwise `unknown`. |

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
