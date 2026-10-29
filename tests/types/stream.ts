// Compiler-only stream selection, inputs and inferred items.

import type {
  Client,
  EndpointMessage,
  EndpointStreamItem,
  ResultEndpoint,
  StreamArgs,
  StreamEndpoint,
  StreamMedia,
  StreamMessage,
  StreamOptions,
} from "../../src/client"
interface Content<M extends string, T> {
  content: Record<M, T>
}
interface Endpoints {
  "GET /events": {
    responses: {
      200: Content<
        "text/event-stream",
        Array<{ event: "added"; data: "hello"; extra: string } | { event: "removed"; data: "bye" }>
      >
    }
  }
  "GET /records": {
    responses: {
      200: Content<
        "application/x-ndjson",
        Array<{ kind: "record" } | null | string | number | boolean | number[]>
      >
    }
  }
  "GET /sequence": {
    responses: { 200: Content<"Application/JSON-SEQ; charset=utf-8", Array<{ id: number } | null>> }
  }
  "GET /jsonl": {
    responses: { 200: Content<"Application/JSONL; charset=utf-8", readonly [null, "one", [1, 2]]> }
  }
  "GET /mixed": {
    responses: {
      200: {
        content: {
          "text/event-stream": Array<{ event: "update"; data: "wire" }>
          "application/x-ndjson": Array<{ kind: "record" }>
          "application/jsonl": number[][]
          "application/json-seq": boolean[]
          "application/json": { complete: true }
        }
      }
    }
  }
  "GET /two-events": {
    responses: {
      200: {
        content: {
          "text/event-stream": Array<{ event: "one" }>
          "Text/Event-Stream; charset=utf-8": Array<{ event: "two" }>
        }
      }
    }
  }
  "POST /events/{id}": {
    params: { id: number }
    query: { topic: string }
    body: { "application/json": { name: string } }
    responses: { 200: Content<"text/event-stream", unknown[]> }
  }
  "GET /never": { responses: { 200: Content<"application/jsonl", never> } }
  "GET /never-item": { responses: { 200: Content<"text/event-stream", never[]> } }
  "GET /plain": { responses: { 200: Content<"application/json", string> } }
  "GET /headless": {
    responses: {
      204: Content<"application/jsonl", string[]>
      205: Content<"text/event-stream", string[]>
    }
  }
  "HEAD /records": { responses: { "2XX": Content<"application/jsonl", string[]> } }
  "GET /error-stream": {
    responses: {
      200: Content<"application/json", string>
      default: Content<"application/jsonl", string[]>
    }
  }
  "GET /fallback": { responses: { default: Content<"application/jsonl", string[]> } }
  "GET /range": {
    responses: {
      200: Content<"application/json", string>
      "2XX": Content<"application/jsonl", number[]>
    }
  }
  "GET /unsupported": { responses: { 200: Content<"application/ndjson", string[]> } }
  "TRACE /records": { responses: { 200: Content<"application/jsonl", string[]> } }
}
declare const api: Client<Endpoints>
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Check<T extends true> = T
const events = api.stream("GET /events")
api.stream("GET /events", undefined)
events satisfies ReadableStream<EndpointMessage<Endpoints, "GET /events">>
export const message: EndpointMessage<Endpoints, "GET /events"> = {
  event: "added",
  data: "hello",
  id: "1",
}
api.stream("GET /events", { retry: false, signal: AbortSignal.abort() })
const limited: Pick<StreamOptions, "maxMessageBytes"> = { maxMessageBytes: 8 * 1024 * 1024 }
api.stream("GET /events", limited) satisfies ReadableStream<
  EndpointMessage<Endpoints, "GET /events">
>
api.stream("GET /events", { ...limited, retry: false })
export function limitedEvents(maxMessageBytes?: number) {
  return api.stream("GET /events", { maxMessageBytes })
}
api.stream("GET /events", {
  retry: { delay: 12, maxRetries: 2 },
  headers: { accept: "text/event-stream" },
})
// @ts-expect-error Web Streams return synchronously
api.stream("GET /events").then()
export async function eventFields() {
  const item = await events.getReader().read()
  if (item.done) return
  if (item.value.event === "added") item.value.data satisfies "hello"
  if (item.value.event === "removed") item.value.data satisfies "bye"
  item.value.id satisfies string
  // @ts-expect-error parser emits only standard SSE fields
  void item.value.extra
}
api.stream("GET /sequence") satisfies ReadableStream<{ id: number } | null>
api.stream("GET /sequence", limited) satisfies ReadableStream<{ id: number } | null>
api.stream("GET /records", limited)
api.stream("GET /jsonl", { ...limited, headers: { accept: "Application/JSONL; charset=utf-8" } })
// @ts-expect-error the per-message limit is numeric
api.stream("GET /events", { maxMessageBytes: "8 MiB" })
// @ts-expect-error parser limits do not apply to raw fetch responses
api.fetch("GET /events", limited)
// @ts-expect-error parser limits do not apply to result decoding
api.result("GET /plain", limited)
// @ts-expect-error a byte limit does not supply required request inputs
api.stream("POST /events/{id}", limited)
// @ts-expect-error sequence operations must use stream or fetch
api.result("GET /sequence")
api.stream("GET /sequence", { retry: false })
api.stream("GET /records") satisfies ReadableStream<
  { kind: "record" } | null | string | number | boolean | number[]
>
api.stream("GET /jsonl", {
  headers: { accept: "Application/JSONL; charset=utf-8" },
}) satisfies ReadableStream<null | "one" | [1, 2]>
api.stream("GET /jsonl", { headers: { accept: "application/jsonl" } })
// @ts-expect-error JSON line streams cannot reconnect
api.stream("GET /records", { retry: { delay: 10 } })
api.stream("GET /jsonl", { retry: false })
api.stream("POST /events/{id}", {
  params: { id: 1 },
  query: { topic: "orders" },
  body: { name: "a" },
  headers: { "content-type": "application/json" },
})
api.stream("POST /events/{id}", {
  baseURL: new URL("https://events.test"),
  params: { id: 1 },
  query: { topic: "orders" },
  body: { name: "a" },
  headers: { "content-type": "application/json" },
})
// @ts-expect-error baseURL does not make the stream's inputs optional
api.stream("POST /events/{id}", { baseURL: "https://events.test" })
// @ts-expect-error stream baseURL must be a string or URL
api.stream("GET /events", { baseURL: 42 })
// @ts-expect-error required operation inputs stay required
api.stream("POST /events/{id}")
// @ts-expect-error query remains required
api.stream("POST /events/{id}", {
  params: { id: 1 },
  body: { name: "a" },
  headers: { "content-type": "application/json" },
})
// @ts-expect-error required body stays required
api.stream("POST /events/{id}", { params: { id: 1 }, query: { topic: "orders" } })
api.stream("POST /events/{id}", {
  headers: { "content-type": "application/json" },
  params: { id: 1 },
  query: { topic: "orders" },
  body: new ReadableStream<Uint8Array>(),
})
api.stream("POST /events/{id}", {
  headers: { "content-type": "application/json" },
  params: { id: 1 },
  query: { topic: "orders" },
  body: new ReadableStream<Uint8Array>(),
  retry: false,
})
api.stream("POST /events/{id}", {
  headers: { "content-type": "application/json" },
  params: { id: 1 },
  query: { topic: "orders" },
  body: new ReadableStream<Uint8Array>(),
  retry: { maxRetries: 0 },
  maxMessageBytes: 1024,
})
// @ts-expect-error a reconnecting subscription still requires replayable bytes
api.stream("POST /events/{id}", {
  headers: { "content-type": "application/json" },
  params: { id: 1 },
  query: { topic: "orders" },
  body: new ReadableStream<Uint8Array>(),
  retry: { maxRetries: 1 },
})
declare const body: AsyncIterable<Uint8Array>
api.stream("POST /events/{id}", { params: { id: 1 }, query: { topic: "orders" }, body })
// @ts-expect-error GET cannot have request bodies
api.stream("GET /events", { body: "hello" })

api.stream("GET /mixed")
api.stream("GET /mixed", {})
api.stream("GET /mixed", {
  retry: { maxRetries: 3 },
  headers: { accept: "text/event-stream" },
}) satisfies ReadableStream<StreamMessage & { event: "update"; data: "wire" }>
api.stream("GET /mixed", { headers: { accept: "application/x-ndjson" } }) satisfies ReadableStream<{
  kind: "record"
}>
api.stream("GET /mixed", { headers: { accept: "application/jsonl" } }) satisfies ReadableStream<
  number[]
>
api.stream("GET /mixed", {
  headers: { accept: "application/json-seq" },
}) satisfies ReadableStream<boolean>
api.stream("GET /mixed", {
  maxMessageBytes: 1024,
  headers: { accept: "application/jsonl" },
}) satisfies ReadableStream<number[]>
api.stream("GET /mixed", { headers: { accept: "application/json" } })
// @ts-expect-error the selected JSON line media forbids retry
api.stream("GET /mixed", { retry: { delay: 1 }, headers: { accept: "application/x-ndjson" } })

api.stream("GET /mixed", {
  headers: { accept: "application/jsonl" },
  // @ts-expect-error selected JSONL item is an array, not an SSE event
}) satisfies ReadableStream<StreamMessage>
api.stream("GET /two-events")
api.stream("GET /two-events", {
  retry: false,
  headers: { accept: "Text/Event-Stream; charset=utf-8" },
}) satisfies ReadableStream<StreamMessage & { event: "two" }>
const selected: StreamArgs<Endpoints, "GET /mixed"> = [
  { retry: false, headers: { accept: "text/event-stream" } },
]
api.stream<"GET /mixed", StreamMedia<Endpoints, "GET /mixed">, object>("GET /mixed", ...selected)
export const invalid: StreamArgs<Endpoints, "GET /mixed"> = [
  // @ts-expect-error a default StreamArgs union must preserve the media/retry association
  { retry: false, headers: { accept: "application/jsonl" } },
]
function forward<K extends StreamEndpoint<Endpoints>, const M extends StreamMedia<Endpoints, K>>(
  key: K,
  ...args: StreamArgs<Endpoints, K, M>
): ReadableStream<EndpointStreamItem<Endpoints, K, M>> {
  return api.stream<K, M, object>(key, ...args)
}
function anyApi<E, K extends StreamEndpoint<E>, const M extends StreamMedia<E, K>>(
  client: Client<E>,
  key: K,
  ...args: StreamArgs<E, K, M>
): ReadableStream<EndpointStreamItem<E, K, M>> {
  return client.stream<K, M, object>(key, ...args)
}
anyApi(api, "GET /mixed", { headers: { accept: "application/jsonl" } }) satisfies ReadableStream<
  number[]
>
anyApi(api, "GET /mixed", {
  maxMessageBytes: 1024,
  headers: { accept: "application/jsonl" },
}) satisfies ReadableStream<number[]>
function forwardDefault<K extends StreamEndpoint<Endpoints>>(
  key: K,
  ...args: StreamArgs<Endpoints, K>
): ReadableStream<EndpointStreamItem<Endpoints, K>> {
  return api.stream<K, StreamMedia<Endpoints, K>, object>(key, ...args)
}
forward("GET /mixed", { headers: { accept: "application/x-ndjson" } }) satisfies ReadableStream<{
  kind: "record"
}>
forwardDefault("GET /events") satisfies ReadableStream<EndpointMessage<Endpoints, "GET /events">>
// @ts-expect-error endpoint unions cannot mix input requirements
api.stream(Math.random() ? "GET /events" : "POST /events/{id}")
// @ts-expect-error supplying init does not make endpoint unions safe
api.stream(Math.random() ? "GET /events" : "POST /events/{id}", {
  params: { id: 1 },
  query: { topic: "orders" },
  body: { name: "a" },
  headers: { "content-type": "application/json" },
})
// Dynamic negotiation retains every supported item alternative.
api.stream("GET /mixed", {
  headers: new Headers({ accept: "text/event-stream, application/jsonl" }),
}) satisfies ReadableStream<EndpointStreamItem<Endpoints, "GET /mixed">>
api.stream("GET /mixed", { headers: { accept: "application/*" } }) satisfies ReadableStream<
  EndpointStreamItem<Endpoints, "GET /mixed">
>
declare const media: "text/event-stream" | "application/jsonl"
api.stream("GET /mixed", { retry: false, headers: { accept: media } })
export type Media = Check<
  Equal<
    StreamMedia<Endpoints, "GET /mixed">,
    "text/event-stream" | "application/x-ndjson" | "application/jsonl" | "application/json-seq"
  >
>
export type NeverItem = Check<Equal<EndpointStreamItem<Endpoints, "GET /never">, never>>
export type NeverEvent = Check<Equal<EndpointStreamItem<Endpoints, "GET /never-item">, never>>
export type JsonEvents = Check<Equal<EndpointMessage<Endpoints, "GET /records">, never>>
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
// @ts-expect-error result cannot read an SSE stream to completion
api.result("GET /events")
// @ts-expect-error result cannot read a JSON line stream to completion
api.result("GET /records")
// @ts-expect-error schema never still declares a stream
"GET /never" satisfies ResultEndpoint<Endpoints>
// @ts-expect-error HEAD has no response body
api.stream("HEAD /records")
// @ts-expect-error bodyless statuses have no streaming response
api.stream("GET /headless")
api.stream("GET /error-stream")
// @ts-expect-error unsupported media stays outside stream
api.stream("GET /unsupported")
// @ts-expect-error fetch-forbidden methods remain unavailable
api.stream("TRACE /records")
// @ts-expect-error unknown operations remain unavailable
api.stream("GET /missing")
