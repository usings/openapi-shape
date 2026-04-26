# openapi-shape

Generate TypeScript declarations and API shapes from OpenAPI JSON.

`openapi-shape` turns an OpenAPI 3.x JSON document into TypeScript declarations: schema types plus an `API` route map that describes params, query, request body, and response for each endpoint.

Use it when you want OpenAPI as a type contract, but you still want to keep your own HTTP layer.

- Emits `.d.ts` declarations.
- Keeps schemas as named TypeScript types.
- Generates an `API` route map keyed by `"METHOD /path"`.
- Includes an optional adapter-based client for typed calls.
- Does not generate a full SDK or own your network stack.

Requires Node >= 18 and TypeScript >= 5.

## Install

If you only generate types:

```sh
pnpm add -D openapi-shape
```

If you use `createClient` at runtime:

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

Common package script:

```json
{
  "scripts": {
    "gen:api": "openapi-shape ./openapi.json -o src/api.d.ts"
  }
}
```

## What You Get

The generated file contains ordinary TypeScript declarations.

```ts
export interface API {
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

`void` means that route has no value for that slot. If all you need is a type boundary between your API spec and your app, this is the whole workflow.

## Optional Typed Client

`createClient<API>(adapter)` gives you one typed request function. It validates the route key, path params, query, body, and response type at compile time.

It is intentionally not a fetch wrapper. Your adapter still owns auth, errors, retries, response parsing, and the HTTP library.

```ts
// src/api-client.ts
import { createClient, type Adapter } from "openapi-shape/client";
import type { API } from "./api";

const adapter: Adapter = async ({ method, url, body, headers }) => {
  const response = await fetch(url, { method, body, headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
};

export const api = createClient<API>(adapter, {
  baseURL: "https://api.example.com",
});
```

Use it from application code:

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

- `headers` are merged after automatic headers, so your values win.
- `options` is passed to the adapter untouched.
- `Adapter<TOptions>` makes `options` typed for axios, ky, ofetch, or your own client.

<details>
<summary>Adapter examples for axios, ky, and ofetch</summary>

Axios:

```ts
import axios, { type AxiosRequestConfig } from "axios";
import { createClient, type Adapter } from "openapi-shape/client";
import type { API } from "./api";

const adapter: Adapter<AxiosRequestConfig> = async ({ method, url, body, headers, options }) => {
  const response = await axios.request({ method, url, data: body, headers, ...options });
  return response.data;
};

export const api = createClient<API, AxiosRequestConfig>(adapter);
```

ky:

```ts
import ky, { type Options as KyOptions } from "ky";
import { createClient, type Adapter } from "openapi-shape/client";
import type { API } from "./api";

const adapter: Adapter<KyOptions> = async ({ method, url, body, headers, options }) => {
  return ky(url, { method, body, headers, ...options }).json();
};

export const api = createClient<API, KyOptions>(adapter);
```

ofetch:

```ts
import { ofetch, type FetchOptions } from "ofetch";
import { createClient, type Adapter } from "openapi-shape/client";
import type { API } from "./api";

const adapter: Adapter<FetchOptions> = async ({ method, url, body, headers, options }) => {
  return ofetch(url, { method, body, headers, ...options });
};

export const api = createClient<API, FetchOptions>(adapter);
```

</details>

## Request Building

The optional client builds the adapter input like this:

| Field     | Behavior                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `method`  | Read from the route key, such as `GET /pets`.                                                                                                                                              |
| `url`     | `baseURL` plus path params and query string. Path params are URL-encoded. Query arrays become repeated keys, for example `tags=a&tags=b`. `null` and `undefined` query values are skipped. |
| `body`    | `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`, typed arrays, and `ReadableStream` pass through unchanged. `undefined` stays `undefined`. Everything else is `JSON.stringify`-ed.    |
| `headers` | JSON bodies get `Content-Type: application/json`. Passthrough bodies get no automatic content type. Per-call headers override auto headers.                                                |
| `options` | Passed through to your adapter without inspection.                                                                                                                                         |

For multipart requests, keep any cast close to the wrapper that knows the route. For example, if your API has a `POST /upload` route:

```ts
import { api } from "./api-client";
import type { API } from "./api";

export function uploadPetPhoto(file: File) {
  const form = new FormData();
  form.append("file", file);

  return api("POST /upload", {
    body: form as API["POST /upload"]["body"],
  });
}
```

<details>
<summary>Production fetch adapter</summary>

```ts
import { createClient, type Adapter } from "openapi-shape/client";
import type { API } from "./api";

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

export const api = createClient<API>(adapter, {
  baseURL: "https://api.example.com",
});
```

</details>

## Programmatic API

Use the generator in build scripts or tests:

```ts
import { generate, generateFromSource } from "openapi-shape";
import { writeFile } from "node:fs/promises";

const code = await generateFromSource("./openapi.json");
await writeFile("src/api.d.ts", code);
```

You can also generate from an already parsed object:

```ts
import { generate } from "openapi-shape";

const code = generate(openapi);
```

Lower-level exports are available when needed: `schemaToType`, `generateSchemas`, `generateRoutes`, and `readSource`.

## Supported

OpenAPI 3.0 and 3.1 JSON specs.

| Feature                                                  | Output                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `components.schemas`                                     | `export interface` or `export type` declarations.                                                                    |
| `$ref` schemas                                           | Preserved as named TypeScript references.                                                                            |
| `$ref` parameters, request bodies, responses, path items | Resolved before route generation.                                                                                    |
| `oneOf` / `anyOf` / `allOf`                              | Union / union / intersection types.                                                                                  |
| `discriminator` on `oneOf` / `anyOf`                     | Discriminator literals injected into branches for narrowable unions, including `allOf` branch schemas.               |
| `enum` / `const`                                         | Literal types.                                                                                                       |
| OpenAPI 3.0 `nullable`                                   | Adds `null`.                                                                                                         |
| OpenAPI 3.1 `type: ["T", "null"]`                        | Adds `null`.                                                                                                         |
| `prefixItems`                                            | Tuple types, with optional rest from `items`.                                                                        |
| `additionalProperties`                                   | `Record<string, T>` or explicit properties plus an index signature.                                                  |
| `requestBody.required`                                   | Honored. Missing or `false` means `body?: T`; `true` means `body: T`.                                                |
| 2xx responses                                            | JSON schema -> typed response, `text/*` -> `string`, binary -> `Blob`, empty success -> `void`, otherwise `unknown`. |

Identifier handling:

- Invalid object property and parameter names are quoted, such as `"user-id"?: string`.
- Invalid or reserved schema names are sanitized, such as `User-Profile` -> `User_Profile` and `class` -> `_class`.
- Schema name collisions after sanitization throw an error.

## Not Supported Yet

- Swagger 2.0. Convert to OpenAPI 3 first.
- YAML input.
- `readOnly` / `writeOnly` request and response variants.
- `format` branding.
- External `$ref` targets such as remote URLs or separate files.
- Error response typing for 4xx / 5xx responses. Handle errors in your adapter.

## License

MIT
