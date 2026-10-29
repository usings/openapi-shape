import { expectTypeOf } from "vitest"
import { createClient } from "../../src/client"
import type { Contract, StreamMessage } from "../../src/client"
interface StreamingEndpoints {
  "GET /events": {
    responses: {
      200: {
        content: {
          "text/event-stream": Array<{ data: string }>
          "application/x-ndjson": Array<{ id: number }>
        }
      }
    }
  }
}
void function defaultStreamChecks(contract: Contract<StreamingEndpoints>) {
  const client = createClient(contract, { headers: { Accept: "text/event-stream" } })
  client.stream("GET /events", { retry: true })
  const stream = client.stream("GET /events", { retry: { maxRetries: 2 } })
  expectTypeOf(stream).toEqualTypeOf<ReadableStream<StreamMessage & { data: string }>>()
  const reader = stream.getReader()
  void reader.read().then(({ value }) => {
    if (value) value.data satisfies string
  })
  const records = client.stream("GET /events", { headers: { ACCEPT: "application/x-ndjson" } })
  expectTypeOf(records).toEqualTypeOf<ReadableStream<{ id: number }>>()
  // @ts-expect-error overriding Accept must preserve non-SSE retry restrictions
  client.stream("GET /events", {
    headers: { ACCEPT: "application/x-ndjson" },
    retry: { maxRetries: 2 },
  })
}

interface MixedEndpoints {
  "POST /mixed": {
    body: { "application/json": { j: string }; "application/x-www-form-urlencoded": { f: string } }
    responses: {
      200: {
        content: {
          "text/event-stream": Array<{ data: string }>
          "application/x-ndjson": Array<{ id: number }>
        }
      }
    }
  }
}
void function mixedMediaChecks(
  contract: Contract<MixedEndpoints>,
  defaults: { authorization: string } | { "content-type": "application/x-www-form-urlencoded" },
) {
  const client = createClient(contract, { headers: { Accept: "text/event-stream" } })
  // @ts-expect-error a default Accept does not supply the form Content-Type
  client.stream("POST /mixed", { body: { f: "form" } })
  // @ts-expect-error case-insensitive headers must retain their body association
  client.stream("POST /mixed", {
    body: { j: "wrong" },
    headers: { "CONTENT-TYPE": "application/x-www-form-urlencoded", "accept": "text/event-stream" },
  })
  // @ts-expect-error opaque Accept overrides cannot enable automatic SSE retry
  client.stream("POST /mixed", {
    body: new Blob(),
    headers: new Headers({ Accept: "application/x-ndjson" }),
    retry: { maxRetries: 1 },
  })
  const dynamic = createClient(contract, { headers: defaults })
  // @ts-expect-error defaults may select form instead of JSON
  dynamic.fetch("POST /mixed", { body: { j: "json" } })
  createClient(contract, {
    headers: { Accept: "text/event-stream" },
    // @ts-expect-error configuration-level signals are forbidden even with inferred options
    signal: AbortSignal.timeout(100),
  })
  client.stream("POST /mixed", {
    body: { j: "json" },
    headers: { "Content-Type": "APPLICATION/JSON; charset=utf-8", "accept": "text/event-stream" },
  })
  client.fetch("POST /mixed", {
    body: { j: "json" },
    headers: { "Content-Type": "APPLICATION/JSON; charset=utf-8" },
  })
}

void function opaqueDefaultChecks(
  contract: Contract<{
    "GET /sse": {
      responses: { 200: { content: { "text/event-stream": Array<{ data: string }> } } }
    }
  }>,
  accept: string,
) {
  const client = createClient(contract, { headers: { accept } })
  // @ts-expect-error an opaque default may negotiate something other than SSE
  client.stream("GET /sse", { retry: { maxRetries: 1 } })
  client.stream("GET /sse", { headers: { ACCEPT: "text/event-stream" }, retry: { maxRetries: 1 } })
}
