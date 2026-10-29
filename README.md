# openapi-shape

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Node.js][node-src]][node-href]
[![License][license-src]][license-href]

**A lightweight, Web standards-based OpenAPI toolkit for TypeScript.**

Generate types and a runtime `contract` from OpenAPI 3.0, 3.1, or 3.2. Make typed requests with native Fetch and consume streams through Web Streams. The generated module and optional `openapi-shape/client` have no runtime dependencies.

## Get started

You need Node.js 22 or later to generate a module. The client needs an ES module environment with Fetch and Web Streams.

Save your OpenAPI JSON or YAML description as `openapi.yaml`. The example below uses the [Petstore description](./docs/examples/petstore.yaml).

```sh
pnpm add openapi-shape
pnpm exec openapi-shape ./openapi.yaml -o src/api.ts
```

Import the generated contract and set `baseURL` to your API's address. Adjust the import path to match your generated file:

<!-- example: standalone -->

```ts
import { createClient } from "openapi-shape/client"
import { contract } from "./api"

const api = createClient(contract, { baseURL: "https://api.example.com/v1" })

const { data, error, status } = await api.result("GET /pets", {
  query: { limit: 10 },
})
if (error !== undefined) throw new Error(`HTTP ${status}`, { cause: error })

console.log(data.map((pet) => pet.name))
```

Endpoint keys such as `GET /pets` select the request and response types. When using your own description, use its declared endpoints and parameters.

## Choose a response API

| Method         | Use it to                                                      | Body ownership                                                                |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `api.result()` | Decode a complete, non-streaming response                      | The client reads it; inspect `status`, `data`, `error`, and response headers. |
| `api.stream()` | Consume SSE messages or JSON records as a `ReadableStream`     | The subscription reads it; cancel when finished.                              |
| `api.fetch()`  | Work with a typed native `Response` from any callable endpoint | You read or cancel it.                                                        |

All three share typed inputs, request defaults, and middleware. You can also use the [generated types](./docs/contract.md) with your own client.

## Documentation

| Task                                                                     | Guide                                    |
| ------------------------------------------------------------------------ | ---------------------------------------- |
| Generate a module, keep it current in CI, or use the JavaScript API      | [Generation](./docs/generation.md)       |
| Send requests, handle responses, add middleware, or write typed wrappers | [Client](./docs/client.md)               |
| Consume SSE, JSONL, NDJSON, or JSON Text Sequences                       | [Streaming](./docs/streaming.md)         |
| Control parameters, forms, multipart uploads, and escaping               | [Serialization](./docs/serialization.md) |
| Use schemas, endpoint types, webhooks, or callbacks directly             | [Generated module](./docs/contract.md)   |
| Check supported features, reference rules, and type approximations       | [OpenAPI support](./docs/openapi.md)     |

For status narrowing, configured defaults, and generic wrappers, see [type inference](./docs/types.md).

## License

_[MIT License](./LICENSE)_

[npm-version-src]: https://img.shields.io/npm/v/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmx.dev/package/openapi-shape
[npm-downloads-src]: https://img.shields.io/npm/dm/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmx.dev/package/openapi-shape
[node-src]: https://img.shields.io/node/v/openapi-shape?style=flat&colorA=080f12&colorB=1fa669
[node-href]: https://nodejs.org
[license-src]: https://img.shields.io/github/license/usings/openapi-shape.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/usings/openapi-shape/blob/main/LICENSE
