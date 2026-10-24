# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Node.js][node-src]][node-href]
[![License][license-src]][license-href]

**OpenAPI types for Fetch.** Generate a TypeScript module from an OpenAPI 3.0, 3.1, or 3.2 description. Call operations by `"METHOD /path"` to read decoded data, consume typed Web Streams, or work directly with a typed `Response`.

- **Web standards.** Build on Fetch, `Request`, `Response`, and `ReadableStream`. Send JSON and multipart forms, transfer files, and consume SSE or JSON line streams with `for await`, readers, or pipes. Share authentication and logging through middleware.
- **Types for real APIs.** Get named component schemas, typed request inputs, and responses that narrow by HTTP status. Documented compatibility rules handle common OpenAPI quirks.
- **Small footprint.** One generated `.ts` file and a dependency-free client. Generated types describe the API; runtime entries store serialization settings and supported streaming media.
- **Controlled generation.** Cancel work, bound document loading, and provide a custom loader for authenticated or cached sources.
- **Automation.** Check generated files with `--check` and inspect diagnostics through `generate()`.

**Contract first. Types are a projection. Validation is a separate responsibility.** OpenAPI and JSON Schema define the contract. `openapi-shape` generates TypeScript types and runtime serialization settings; it does not validate runtime data. Types alone do not prove validity, conformance, or authenticity. See [support and limits](./docs/openapi.md#support-boundaries).

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

All three methods share typed request inputs and middleware. The [client guide](./docs/client.md) covers endpoint selection, response handling, and connection management.

The generated module has no imports or runtime dependencies. Its `Endpoints` and `Schemas` [types also work with your own client](./docs/output.md).

## Requirements

- **Generator:** Node.js 22 or later.
- **Client:** a runtime with standard Fetch API globals.

The generated module and client use ES modules. CommonJS is not supported. Generate the module with the same installed package used by your application; see [format compatibility](./docs/output.md#format-compatibility).

## Documentation

- [The generated module](./docs/output.md): `Endpoints`, `Webhooks`, `Callbacks`, `Schemas`, and the runtime `contract`.
- [Client](./docs/client.md): typed calls, request encoding, responses, streams, and middleware.
- [OpenAPI support](./docs/openapi.md): supported versions, references, schemas, media types, compatibility rules, and approximations.
- [CLI and programmatic API](./docs/cli.md): options, `--check`, `generate()`, cancellation, and diagnostics.

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
