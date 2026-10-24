import type { ClientOptions, StreamMessage } from "../../src/client"
import { createClient } from "../../src/client"
import type { ResultOperation } from "./contract"

type StreamOperation<Request = Record<never, never>> = Omit<
  ResultOperation<Request>,
  "responses"
> & {
  responses: { 200: { content: { "text/event-stream": StreamMessage[] } } }
}

export function sseClient(options: ClientOptions = {}) {
  return createClient<{
    "GET /events": StreamOperation
    "POST /events/{id}": StreamOperation<{
      params: { id: number }
      body: { topic: string } | Blob | ReadableStream | AsyncIterable<Uint8Array>
    }>
    "GET /ordinary": ResultOperation
  }>(
    {
      version: 5,
      endpoints: {
        "GET /events": { stream: ["text/event-stream"] },
        "POST /events/{id}": { stream: ["text/event-stream"] },
        "GET /ordinary": {},
      },
    },
    { baseUrl: "https://example.test", ...options },
  )
}

export function sseResponse(text = "data: hello\n\n"): Response {
  return new Response(text, { headers: { "content-type": "Text/Event-Stream; charset=utf-8" } })
}

export function bytes(chunks: Uint8Array[], failure?: Error): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++])
      else if (failure) controller.error(failure)
      else controller.close()
    },
  })
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const item of items) values.push(item)
  return values
}
