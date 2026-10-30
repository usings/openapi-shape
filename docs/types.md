# Type inference and wrappers

The client derives inputs and responses from the generated `Endpoints`. It does not validate payload values at runtime.

## Narrow successful responses

`result()` puts declared 2xx responses in `data` and other declared statuses in `error`. Checking `error !== undefined` handles HTTP failure; it does not select one particular successful response schema.

A success check narrows `data` to the union of successful payloads. When these have different shapes, check `status` to select one. For example, `200` can describe a list while `default` describes other statuses, including other successes:

<!-- example: standalone -->

```ts
import type { Client } from "openapi-shape/client"

declare const api: Client<{
  "GET /fallback": {
    responses: {
      200: { content: { "application/json": Array<{ name: string }> } }
      default: { content: { "application/json": { message?: string } } }
    }
  }
}>

const { data, error, status } = await api.result("GET /fallback")
if (error !== undefined) throw new Error(`HTTP ${status}`, { cause: error })

if (status === 200) {
  console.log(data.map((pet) => pet.name))
} else if (status === 204 || status === 205) {
  console.log("No content")
} else {
  console.log(data?.message)
}
```

A `2XX` range includes 204 and 205, so its successful data can also be `undefined`. See [status rules](./client.md#status-typing) and [rejected calls](./client.md#handle-rejected-calls) for runtime behavior.

## Forward typed calls

Preserve the complete result with `EndpointResult`, so callers retain status narrowing, error bodies and response headers. A data-only helper can build on that wrapper using `EndpointData`:

<!-- example: standalone -->

```ts
import {
  createClient,
  type EndpointArgs,
  type EndpointData,
  type EndpointResult,
  type ResultEndpoint,
} from "openapi-shape/client"
import { contract, type Endpoints } from "./api"

const api = createClient(contract, { baseURL: "https://api.example.com/v1" })
export function result<K extends ResultEndpoint<Endpoints>>(
  endpoint: K,
  ...args: EndpointArgs<Endpoints, K>
): Promise<EndpointResult<Endpoints, K>> {
  return api.result(endpoint, ...args)
}

// A data-only helper can build on the complete result.
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

| API      | Endpoint keys               | Arguments                     | Value                                              |
| -------- | --------------------------- | ----------------------------- | -------------------------------------------------- |
| `fetch`  | `Endpoint<Endpoints>`       | `EndpointArgs<Endpoints, K>`  | `ResponseOf<Endpoints, K>`, narrowed by status     |
| `result` | `ResultEndpoint<Endpoints>` | `EndpointArgs<Endpoints, K>`  | `EndpointResult<Endpoints, K>` for the full result |
| `stream` | `StreamEndpoint<Endpoints>` | `StreamArgs<Endpoints, K, M>` | `EndpointStreamItem<Endpoints, K, M>` per item     |

`EndpointData<Endpoints, K>` names only the successful decoded data. `TypedResponse<Status, Ok, Json, HeaderName>` annotates an individual native response; normal calls infer it.

A call names one endpoint, not a union of keys. `Middleware`, `MiddlewareContext`, and `Fetcher` type request wrappers and transports.

### Forward stream calls

Stream wrappers should preserve `M extends StreamMedia<Endpoints, K>` so `headers.accept` narrows the item. Use `NegotiatedStreamArgs<Endpoints, K, D>` for dynamic Accept lists or opaque headers; its result keeps all declared stream item alternatives and automatic reconnection is disabled. `EndpointMessage` is SSE-specific; `StreamOptions` and `StreamRetryOptions` describe stream settings.

Stream wrappers preserving generic `K` and `M` use `client.stream<K, M, object>(endpoint, ...args)` so the helper's canonical header constraints are retained.

## Preserve configured defaults

`Client<Endpoints, D, A>` records a known default Content-Type in `D` and default Accept information in `A`. Default header values affect which structured inputs and stream selections the compiler can establish; see [media selection](./client.md#select-media) and [stream selection](./streaming.md#select-a-representation).

Known literal Content-Type defaults or call headers associate structured bodies with their declared schemas. Opaque defaults require an explicit call Content-Type for structured input. Type/subtype casing and additional parameters are accepted when the declaration is unambiguous; parameterized declarations require an exact match when static parameter precedence cannot be established. `Headers` objects and entry lists remain usable for ready bodies and dynamic response negotiation.

Forward `D` through `EndpointArgs<Endpoints, K, D>` or `StreamArgs<Endpoints, K, M, D>` when wrapping a configured client. Omit it for the ordinary JSON fallback. The stream helper describes a call's selected media through `M`; default Accept selection belongs to the configured client method.

Generic wrappers must forward the endpoint and argument tuple together, including the configured media generic when it changes the allowed inputs.
