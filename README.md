# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Node.js][node-src]][node-href]
[![License][license-src]][license-href]

**OpenAPI-shaped fetch.** One generated TypeScript module types every operation of an OpenAPI 3.0, 3.1, or 3.2 API by `"METHOD /path"`, and a small client turns it into a typed `fetch`: a standard `Request` in, a standard `Response` out.

- **Web standards.** Requests are `Request`s and responses `Response`s; bodies are JSON, `FormData`, `Blob`s, and streams. Middleware takes a `Request` and the next step, and resolves to a `Response`.
- **Types that follow the API.** Every schema becomes a named type, and every response is typed by status and media type. Where a document's letter and the real API part ways, the output follows the API, by rules the docs set out; warnings are left for what someone can act on.
- **Small.** One generated `.ts` file; the client is one dependency-free module.
- **CI-ready.** `--check` fails when the committed file is out of date.

## Quick start

```sh
pnpm add openapi-shape
pnpm exec openapi-shape ./openapi.yaml -o src/api.ts
```

The source may be a file path or an HTTP(S) URL, in JSON or YAML; `$ref`s to other files and URLs are followed, preserving local fields through Path Item reference chains. Call the API through the client:

```ts
import { createClient } from "openapi-shape/client"
import { contract } from "./api"

const api = createClient(contract, {
  baseUrl: "https://api.example.com/v1",
  headers: { authorization: `Bearer ${token}` },
})

// The body, read and decoded: `data` for a 2xx status, `error` for any other, never both.
const { data, error } = await api.result("GET /pets", { query: { limit: 10 } })
if (error !== undefined) throw new Error(error?.message ?? "Request failed") // error: Schemas.Error | null
console.log(data.length) // data: Schemas.Pet[]

// The Response itself, typed by status.
const res = await api.fetch("GET /pets/{petId}", { params: { petId: 1 } })
if (res.status === 404) console.warn((await res.json()).message) // Schemas.Error
```

Or use the types alone, with a client of your own:

```ts
import type { Endpoints, Schemas } from "./api"

type Pet = Schemas.Pet
type ListPets = Endpoints["GET /pets"]["responses"]["200"]["content"]["application/json"] // Schemas.Pet[]
```

The module imports nothing, so `import type` reads its types without loading it or needing `openapi-shape` installed.

The generated module and the client are ES modules; CommonJS is not supported. The generator runs on Node.js 22 or later, and the client wherever `fetch` does.

## Documentation

- [The generated module](./docs/output.md): `Endpoints`, `Webhooks`, `Callbacks`, `Schemas`, and the runtime `contract`.
- [Client](./docs/client.md): the two calls, what they take, how requests are encoded and responses decoded, middleware, and passing calls on.
- [OpenAPI support](./docs/openapi.md): versions and references, operations, media types, schemas, and where the output follows the real API or approximates.
- [CLI and programmatic API](./docs/cli.md): options, `--check`, `generate()`, and diagnostics.

## Development

Run `pnpm verify` to run the tests, TypeScript checks, lint, and formatting checks. The TypeScript check also validates the compile-time assertions in the tests; `pnpm test --run` alone does not check those assertions.

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
