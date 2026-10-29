# Type inference and wrappers

The client derives inputs and responses from the generated `Endpoints`. It does not validate payload values at runtime.

## Forward typed calls

Use the exported helpers rather than reconstructing operation types:

<!-- example: standalone -->

```ts
import {
  createClient,
  type EndpointArgs,
  type EndpointData,
  type ResultEndpoint,
} from "openapi-shape/client"
import { contract, type Endpoints } from "./api"

const { result } = createClient(contract, { baseURL: "https://api.example.com/v1" })
export async function data<K extends ResultEndpoint<Endpoints>>(
  endpoint: K,
  ...args: EndpointArgs<Endpoints, K>
): Promise<EndpointData<Endpoints, K>> {
  const { data, error, status } = await result(endpoint, ...args)
  if (error !== undefined) throw new Error(`HTTP ${status}`, { cause: error })
  return data
}
const pet = await data("GET /pets/{petId}", { params: { petId: 1 } })
console.log(pet.name)
```

| API      | Endpoint keys               | Arguments                     | Value                                          |
| -------- | --------------------------- | ----------------------------- | ---------------------------------------------- |
| `fetch`  | `Endpoint<Endpoints>`       | `EndpointArgs<Endpoints, K>`  | `TypedResponse`, narrowed by status            |
| `result` | `ResultEndpoint<Endpoints>` | `EndpointArgs<Endpoints, K>`  | `EndpointData<Endpoints, K>` for success data  |
| `stream` | `StreamEndpoint<Endpoints>` | `StreamArgs<Endpoints, K, M>` | `EndpointStreamItem<Endpoints, K, M>` per item |

A call names one endpoint, not a union of keys. Stream wrappers should preserve `M extends StreamMedia<Endpoints, K>` so `headers.accept` narrows the item. Use `NegotiatedStreamArgs<Endpoints, K, D>` for dynamic Accept lists or opaque headers; its result keeps all declared stream item alternatives and automatic reconnection is disabled. `EndpointMessage` is SSE-specific; `StreamOptions` and `StreamRetryOptions` describe stream settings. `Middleware`, `MiddlewareContext`, and `Fetcher` type request wrappers and transports.

## Preserve configured defaults

Configured clients carry their known default media as the second `Client<Endpoints, D>` type parameter. Wrappers that preserve configured defaults should also forward `D` through `EndpointArgs<Endpoints, K, D>` or `StreamArgs<Endpoints, K, M, D>`. Omit it for the ordinary JSON fallback.

When a generic wrapper forwards an already checked `EndpointArgs<Endpoints, K>` tuple, use `client.result<K, object>(endpoint, ...args)`. For `StreamArgs<Endpoints, K, M>`, use `client.stream<K, M, object>(endpoint, ...args)`. The explicit header parameter keeps the helper's canonical header constraints; direct calls infer header spelling and media values automatically.
