# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Node.js][node-src]][node-href]
[![License][license-src]][license-href]

**OpenAPI-shaped fetch.** Generate a TypeScript module from an OpenAPI 3.0, 3.1, or 3.2 description. Call operations by `"METHOD /path"` with a typed `fetch` client built around standard `Request` and `Response` objects.

- **Web standards.** Send JSON, multipart forms with per-part encoding, `Blob`s, and streams. Add middleware for authentication, retries, and logging.
- **Types for real APIs.** Get named component schemas, typed request inputs, and responses that narrow by HTTP status. Documented compatibility rules handle common OpenAPI quirks.
- **Small footprint.** One generated `.ts` file and a dependency-free client.
- **Controlled generation.** Cancel work, bound document loading, and provide a custom loader for authenticated or cached sources.
- **CI-ready.** Use `--check` to catch outdated generated files.

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

const api = createClient(contract, { baseUrl: "https://api.example.com/v1" })

const { data: pets, error } = await api.result("GET /pets", { query: { limit: 10 } })
if (error !== undefined) throw new Error(error?.message ?? "Could not load pets")

console.log(pets.map((pet) => pet.name)) // pets: Schemas.Pet[]
```

Use `api.result()` for decoded data or `api.fetch()` for a typed `Response`. See the [client guide](./docs/client.md) for response handling, middleware, and streams.

The generated module has no imports or runtime dependencies. Its `Endpoints` and `Schemas` [types also work with your own client](./docs/output.md).

## Requirements

- **Generator:** Node.js 22 or later.
- **Client:** a runtime with `fetch` support.

The generated module and client use ES modules. CommonJS is not supported. The generated contract version must match the client. If they differ, regenerate the module with the installed version of openapi-shape. See [contract compatibility](./docs/output.md#format-compatibility).

## Documentation

- [The generated module](./docs/output.md): `Endpoints`, `Webhooks`, `Callbacks`, `Schemas`, and the runtime `contract`.
- [Client](./docs/client.md): requests, responses, serialization, middleware, and typed wrappers.
- [OpenAPI support](./docs/openapi.md): supported versions, references, schemas, media types, compatibility rules, and approximations.
- [CLI and programmatic API](./docs/cli.md): options, `--check`, `generate()`, and diagnostics.

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
