# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Node.js][node-src]][node-href]
[![License][license-src]][license-href]

**OpenAPI types for Fetch.** Generate one TypeScript module from an OpenAPI 3.0, 3.1, or 3.2 description, then call operations by `"METHOD /path"`.

- **Type safety.** Typed request inputs and responses that narrow by HTTP status.
- **Web standards.** Built on Fetch, `Request`, `Response`, and native `ReadableStream`; consume streams with `for await`, readers, or pipes.
- **Response handling.** Decoded results, typed `Response` objects, and SSE, JSONL, or NDJSON streams.
- **Lightweight client.** No runtime dependencies, with shared request defaults and middleware across all three methods.

## Quick start

Install the package and generate a module from your API description:

```sh
pnpm add openapi-shape
pnpm exec openapi-shape ./openapi.yaml -o src/api.ts
```

The source can be a local JSON or YAML file or an HTTP(S) URL. External references resolve automatically. Import the generated contract to make a request:

```ts
import { createClient } from "openapi-shape/client"
import { contract } from "./api"

const api = createClient(contract, { baseURL: "https://api.example.com/v1" })

const { data: pets, error } = await api.result("GET /pets", { query: { limit: 10 } })
if (error !== undefined) throw new Error(error?.message ?? "Could not load pets")

console.log(pets.map((pet) => pet.name)) // pets: Schemas.Pet[]
```

Choose how to consume a response:

| Method         | Use                                                                             |
| -------------- | ------------------------------------------------------------------------------- |
| `api.result()` | Read and decode a non-streaming endpoint's complete response.                   |
| `api.stream()` | Consume typed SSE messages or JSON line records from a native `ReadableStream`. |
| `api.fetch()`  | Get a typed `Response` from any callable endpoint and read its body yourself.   |

All three methods share typed request inputs and middleware.

The generated module has no imports or runtime dependencies. Its `Endpoints` and `Schemas` [types also work with your own client](./docs/generated.md).

The generated types describe the API; the client does not validate payloads against schemas. See [support and limits](./docs/openapi.md#support-boundaries).

## Requirements

- **Generator:** Node.js 22 or later.
- **Client:** a runtime with standard Fetch and Web Streams globals.

The generated module and client use ES modules. CommonJS is not supported. The client accepts only its matching [contract format](./docs/generated.md#format-compatibility); generate with the package installed in your application.

## Documentation

- [CLI](./docs/cli.md): command options, generated file checks, and output behavior.
- [Client](./docs/client.md): requests, decoded results, typed responses, SSE/JSONL streams, and helper types.
- [Middleware](./docs/middleware.md): HTTP wrappers, authentication, timeouts, and response ownership.
- [OpenAPI support](./docs/openapi.md): supported versions, references, schemas, media types, compatibility rules, and approximations.
- [Generator API](./docs/generator.md): `generate()`, loading, cancellation, and diagnostics.
- [The generated module](./docs/generated.md): `Endpoints`, `Webhooks`, `Callbacks`, `Schemas`, and the runtime `contract`.

## Development

Run `pnpm verify` for tests, type checking, lint, and formatting checks. This also validates the compile-time assertions that `pnpm test --run` alone does not check.

## License

[MIT](./LICENSE)

[npm-version-src]: https://img.shields.io/npm/v/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmx.dev/package/openapi-shape
[npm-downloads-src]: https://img.shields.io/npm/dm/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmx.dev/package/openapi-shape
[node-src]: https://img.shields.io/node/v/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[node-href]: https://nodejs.org
[license-src]: https://img.shields.io/github/license/usings/openapi-shape.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/usings/openapi-shape/blob/main/LICENSE
