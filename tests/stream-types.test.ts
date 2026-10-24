import { describe, it } from "vitest"
import { expectPassesTsc } from "./helpers/tsc"

const declarations = `
import type {
  Client, EndpointMessage, EndpointStreamItem, ResultEndpoint, StreamArgs,
  StreamEndpoint, StreamMedia, StreamMessage,
} from "openapi-shape/client"
type Content<M extends string, T> = { content: { [P in M]: T } }
interface Endpoints {
  "GET /events": { responses: { 200: Content<"text/event-stream", ({ event: "added"; data: "hello"; extra: string } | { event: "removed"; data: "bye" })[]> } }
  "GET /records": { responses: { 200: Content<"application/x-ndjson", ({ kind: "record" } | null | string | number | boolean | number[])[]> } }
  "GET /jsonl": { responses: { 200: Content<"Application/JSONL; charset=utf-8", readonly [null, "one", [1, 2]]> } }
  "GET /mixed": { responses: { 200: { content: {
    "text/event-stream": { event: "update"; data: "wire" }[]
    "application/x-ndjson": { kind: "record" }[]
    "application/jsonl": number[][]
    "application/json": { complete: true }
  } } } }
  "GET /two-events": { responses: { 200: { content: {
    "text/event-stream": { event: "one" }[]
    "Text/Event-Stream; charset=utf-8": { event: "two" }[]
  } } } }
  "POST /events/{id}": {
    params: { id: number }
    query: { topic: string }
    body: { "application/json": { name: string } }
    responses: { 200: Content<"text/event-stream", unknown[]> }
  }
  "GET /never": { responses: { 200: Content<"application/jsonl", never> } }
  "GET /never-item": { responses: { 200: Content<"text/event-stream", never[]> } }
  "GET /plain": { responses: { 200: Content<"application/json", string> } }
  "GET /headless": { responses: { 204: Content<"application/jsonl", string[]>; 205: Content<"text/event-stream", string[]> } }
  "HEAD /records": { responses: { "2XX": Content<"application/jsonl", string[]> } }
  "GET /error-stream": { responses: { 200: Content<"application/json", string>; default: Content<"application/jsonl", string[]> } }
  "GET /fallback": { responses: { default: Content<"application/jsonl", string[]> } }
  "GET /range": { responses: { 200: Content<"application/json", string>; "2XX": Content<"application/jsonl", number[]> } }
  "GET /unsupported": { responses: { 200: Content<"application/ndjson", string[]> } }
  "TRACE /records": { responses: { 200: Content<"application/jsonl", string[]> } }
}
declare const api: Client<Endpoints>
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Check<T extends true> = T
`

describe("stream types", () => {
  it("selects native stream items by declared media and preserves request inputs", async () => {
    await expectPassesTsc(`${declarations}
const events = api.stream("GET /events")
api.stream("GET /events", undefined)
events satisfies ReadableStream<EndpointMessage<Endpoints, "GET /events">>
api.stream("GET /events", { retry: false, signal: AbortSignal.abort() })
api.stream("GET /events", { accept: "text/event-stream", retry: { delay: 12, maxRetries: 2 } })
// @ts-expect-error Web Streams return synchronously
api.stream("GET /events").then(() => {})
// @ts-expect-error lifecycle callbacks were replaced by Web Streams
api.stream("GET /events", { onMessage() {} })
async function eventFields() {
  const item = await events.getReader().read()
  if (item.done) return
  if (item.value.event === "added") item.value.data satisfies "hello"
  if (item.value.event === "removed") item.value.data satisfies "bye"
  item.value.id satisfies string
  // @ts-expect-error parser emits only standard SSE fields
  item.value.extra
}
api.stream("GET /records") satisfies ReadableStream<{ kind: "record" } | null | string | number | boolean | number[]>
api.stream("GET /jsonl", { accept: "Application/JSONL; charset=utf-8" }) satisfies ReadableStream<null | "one" | [1, 2]>
// @ts-expect-error accept retains exact declared spelling and parameters
api.stream("GET /jsonl", { accept: "application/jsonl" })
// @ts-expect-error JSON line streams cannot reconnect
api.stream("GET /records", { retry: { delay: 10 } })
// @ts-expect-error even retry:false is SSE-only
api.stream("GET /jsonl", { retry: false })
api.stream("POST /events/{id}", { params: { id: 1 }, query: { topic: "orders" }, body: { name: "a" } })
// @ts-expect-error required operation inputs stay required
api.stream("POST /events/{id}")
// @ts-expect-error query remains required
api.stream("POST /events/{id}", { params: { id: 1 }, body: { name: "a" } })
// @ts-expect-error required body stays required
api.stream("POST /events/{id}", { params: { id: 1 }, query: { topic: "orders" } })
// @ts-expect-error a streaming request body cannot be replayed
api.stream("POST /events/{id}", { params: { id: 1 }, query: { topic: "orders" }, body: new ReadableStream<Uint8Array>() })
declare const body: AsyncIterable<Uint8Array>
// @ts-expect-error async iterable bodies cannot be replayed
api.stream("POST /events/{id}", { params: { id: 1 }, query: { topic: "orders" }, body })
// @ts-expect-error GET cannot have request bodies
api.stream("GET /events", { body: "hello" })
`)
  })

  it("requires a media choice, associates retries with SSE, and preserves generic wrappers", async () => {
    await expectPassesTsc(`${declarations}
// @ts-expect-error several declared stream media require accept
api.stream("GET /mixed")
// @ts-expect-error an empty init still lacks its media choice
api.stream("GET /mixed", {})
api.stream("GET /mixed", { accept: "text/event-stream", retry: { maxRetries: 3 } }) satisfies ReadableStream<StreamMessage & { event: "update"; data: "wire" }>
api.stream("GET /mixed", { accept: "application/x-ndjson" }) satisfies ReadableStream<{ kind: "record" }>
api.stream("GET /mixed", { accept: "application/jsonl" }) satisfies ReadableStream<number[]>
// @ts-expect-error ordinary JSON is not a streaming choice
api.stream("GET /mixed", { accept: "application/json" })
// @ts-expect-error the selected JSON line media forbids retry
api.stream("GET /mixed", { accept: "application/x-ndjson", retry: { delay: 1 } })
// @ts-expect-error selected JSONL item is an array, not an SSE event
api.stream("GET /mixed", { accept: "application/jsonl" }) satisfies ReadableStream<StreamMessage>
// @ts-expect-error several SSE declarations still need an exact accept choice
api.stream("GET /two-events")
api.stream("GET /two-events", { accept: "Text/Event-Stream; charset=utf-8", retry: false }) satisfies ReadableStream<StreamMessage & { event: "two" }>
const selected: StreamArgs<Endpoints, "GET /mixed"> = [{ accept: "text/event-stream", retry: false }]
api.stream("GET /mixed", ...selected)
// @ts-expect-error a default StreamArgs union must preserve the media/retry association
const invalid: StreamArgs<Endpoints, "GET /mixed"> = [{ accept: "application/jsonl", retry: false }]
function forward<K extends StreamEndpoint<Endpoints>, const M extends StreamMedia<Endpoints, K>>(
  key: K, ...args: StreamArgs<Endpoints, K, M>
): ReadableStream<EndpointStreamItem<Endpoints, K, M>> {
  return api.stream(key, ...args)
}
function anyApi<E, K extends StreamEndpoint<E>, const M extends StreamMedia<E, K>>(
  client: Client<E>, key: K, ...args: StreamArgs<E, K, M>
): ReadableStream<EndpointStreamItem<E, K, M>> {
  return client.stream(key, ...args)
}
anyApi(api, "GET /mixed", { accept: "application/jsonl" }) satisfies ReadableStream<number[]>
function forwardDefault<K extends StreamEndpoint<Endpoints>>(
  key: K, ...args: StreamArgs<Endpoints, K>
): ReadableStream<EndpointStreamItem<Endpoints, K>> {
  return api.stream(key, ...args)
}
forward("GET /mixed", { accept: "application/x-ndjson" }) satisfies ReadableStream<{ kind: "record" }>
forwardDefault("GET /events") satisfies ReadableStream<EndpointMessage<Endpoints, "GET /events">>
// @ts-expect-error endpoint unions cannot mix input requirements
api.stream(Math.random() ? "GET /events" : "POST /events/{id}")
// @ts-expect-error supplying init does not make endpoint unions safe
api.stream(Math.random() ? "GET /events" : "POST /events/{id}", { params: { id: 1 }, query: { topic: "orders" }, body: { name: "a" } })
declare const media: "text/event-stream" | "application/jsonl"
// @ts-expect-error a possibly JSONL selection cannot promise SSE retry
api.stream("GET /mixed", { accept: media, retry: false })
type Media = Check<Equal<StreamMedia<Endpoints, "GET /mixed">, "text/event-stream" | "application/x-ndjson" | "application/jsonl">>
type NeverItem = Check<Equal<EndpointStreamItem<Endpoints, "GET /never">, never>>
type NeverEvent = Check<Equal<EndpointStreamItem<Endpoints, "GET /never-item">, never>>
type JsonEvents = Check<Equal<EndpointMessage<Endpoints, "GET /records">, never>>
api.stream("GET /never") satisfies ReadableStream<never>
api.stream("GET /never-item") satisfies ReadableStream<never>
"GET /range" satisfies StreamEndpoint<Endpoints>
"GET /fallback" satisfies StreamEndpoint<Endpoints>
api.stream("GET /range") satisfies ReadableStream<number>
api.result("GET /plain")
api.result("HEAD /records")
api.result("GET /headless")
api.result("GET /error-stream")
api.result("GET /unsupported")
// @ts-expect-error result cannot read a JSON line stream to completion
api.result("GET /records")
// @ts-expect-error schema never still declares a stream
"GET /never" satisfies ResultEndpoint<Endpoints>
// @ts-expect-error HEAD has no response body
api.stream("HEAD /records")
// @ts-expect-error bodyless statuses have no streaming response
api.stream("GET /headless")
// @ts-expect-error a failed stream response is not a stream endpoint
api.stream("GET /error-stream")
// @ts-expect-error unsupported media stays outside stream
api.stream("GET /unsupported")
// @ts-expect-error fetch-forbidden methods remain unavailable
api.stream("TRACE /records")
// @ts-expect-error unknown endpoints remain unavailable
api.stream("GET /missing")
`)
  })
})
