# Middleware

Middleware wraps HTTP exchanges from all three methods, including SSE reconnections. The chain is fixed when the client is created, with the first middleware outermost. Each function receives `(request, next, context)` and resolves to a `Response`; the client's `fetch` option is the final transport.

```ts
import { createClient, defineMiddleware } from "openapi-shape/client"
import { contract } from "./api"

const auth = defineMiddleware(async (request, next) => {
  const authorized = new Request(request)
  authorized.headers.set("authorization", `Bearer ${await getToken()}`)
  return next(authorized)
})
const logger = defineMiddleware(async (request, next, context) => {
  const response = await next(request)
  console.log(context.kind, context.endpoint, response.status)
  return response
})
const api = createClient(contract, {
  baseURL: "https://api.example.com/v1",
  middleware: [logger, auth],
})
```

## Execution and context

`defineMiddleware` supplies contextual types and returns the same function. `Middleware` describes a wrapper; `Fetcher` describes `next` and the transport. A wrapper can forward a replacement request, return a response directly, or call `next` repeatedly; each call continues through the remaining chain. Put transport test doubles in `fetch` so middleware still runs.

`MiddlewareContext` is read-only: `endpoint` is the original `"METHOD /path"` template, and `kind` is `"fetch"`, `"result"`, or `"stream"`. It stays unchanged when middleware rewrites a request and retains those values on SSE reconnection. `kind` identifies the client method; `fetch` can also return an indefinite stream.

The chain ends when it hands off the response. Result decoding and stream parsing happen afterward, so their errors reach the API caller or stream consumer. The logger above observes HTTP responses before body processing completes.

SSE reconnections rerun the full chain. An unchanged transport rejection is eligible for the [SSE retry policy](./client.md#sse-reconnection); middleware's own thrown errors terminate the subscription.

## Signals and timeouts

Use client header defaults for static credentials and middleware for refreshed credentials. Client defaults exclude `signal`; pass cancellation signals per call. Preserve `request.signal` when forwarding a replacement request. For a per-attempt timeout, combine signals in middleware:

```ts
import { defineMiddleware } from "openapi-shape/client"

export const timeout = defineMiddleware((request, next) => {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  return next(new Request(request, { signal }))
})
```

That timeout also applies while Fetch reads the response body. For long-lived SSE, choose a timeout that permits the intended connection lifetime.

The original call signal governs pending dispatch even if middleware replaces the outgoing signal. Abort rejects that exchange with `signal.reason` and prevents retained `next` functions from sending again. Stream subscriptions also cancel consumption and reconnection waits.

## Bodies and ownership

Requests pass by reference: in-place changes remain visible to outer middleware. Forward a `new Request(request, init)` to isolate changes; its constructor takes over the original body.

Bodies are single-use. Clone a request before the first attempt if retrying. Read or cancel an unused response before waiting to retry so its connection can be reused. Inspect `response.clone()` only when its consumption can finish: `clone().text()` waits for EOF, and unread tee branches can buffer data on indefinite streams.

The client cancels unselected responses passing through the chain, including intermediate replacements and late responses after completion, failure, or cancellation. The selected response and wrappers sharing its body are retained. Finish processing before returning; private clones and reader locks acquired inside middleware remain its responsibility.

After delivery, the `fetch` caller owns its response, the result decoder consumes a `result` response, and the stream session consumes a `stream` response.
