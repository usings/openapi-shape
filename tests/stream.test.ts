import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClientOptions, Fetcher, StreamMessage } from "../src/client"
import { createClient, StreamResponseError } from "../src/client"
import { readEvents } from "../src/client/sse"
import { generate } from "../src/core/index"
import type { ResultOperation } from "./helpers/contract"
import { contractOf } from "./helpers/contract"
import { oas } from "./helpers/generate"
import { typecheck } from "./helpers/tsc"

type StreamOperation<Request = Record<never, never>> = Omit<
  ResultOperation<Request>,
  "responses"
> & {
  responses: { 200: { content: { "text/event-stream": StreamMessage[] } } }
}

function client(options: ClientOptions = {}) {
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

function response(text = "data: hello\n\n"): Response {
  return new Response(text, { headers: { "content-type": "Text/Event-Stream; charset=utf-8" } })
}

function bytes(chunks: Uint8Array[], failure?: Error): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++])
      else if (failure) controller.error(failure)
      else controller.close()
    },
  })
}

afterEach(() => vi.useRealTimers())

describe("SSE parsing", () => {
  it("preserves events for every byte split, including UTF-8, BOM and CRLF", async () => {
    const text =
      "\uFEFF: comment\r\nid: cursor\r\nevent: update\rdata:\rdata: 雪😀\nretry: 7\r\n\r\n: ping\n\nid\n\ndata: end\n\ndata: unfinished"
    const encoded = new TextEncoder().encode(text)
    const expected = [
      { data: "\n雪😀", event: "update", id: "cursor", retry: 7 },
      { data: "end", event: "message", id: "" },
    ]
    const partitions = Array.from({ length: encoded.length + 1 }, (_, i) => [
      encoded.slice(0, i),
      encoded.slice(i),
    ])
    partitions.push([...encoded].map((byte) => new Uint8Array([byte])))
    for (const chunks of partitions) {
      const state = { id: "", retry: 1000 }
      const events: StreamMessage[] = []
      // oxlint-disable-next-line no-await-in-loop -- exercise each partition independently
      for await (const event of readEvents(bytes(chunks), state, new AbortController().signal))
        events.push(event)
      expect(events).toStrictEqual(expected)
      expect(state).toStrictEqual({ id: "", retry: 7 })
    }
  })

  it("ignores invalid retry and id fields, unknown fields, comments and incomplete cursors", async () => {
    const state = { id: "old", retry: 1000 }
    const body = new TextEncoder().encode(
      "retry: 5x\nretry: -1\nretry: 1.2\nretry: 9007199254740992\nid: bad\0id\nunknown: x\n: ping\n\ndata\n\nid: partial\ndata: lost",
    )
    const events: StreamMessage[] = []
    for await (const event of readEvents(bytes([body]), state, new AbortController().signal))
      events.push(event)
    expect(events).toStrictEqual([{ data: "", event: "message", id: "old" }])
    expect(state).toStrictEqual({ id: "old", retry: 1000 })
  })
})

it("keeps generated classification, inferred events and runtime behavior aligned", async () => {
  const sse = {
    description: "events",
    content: {
      "Text/Event-Stream; charset=utf-8": {
        itemSchema: {
          oneOf: [
            {
              type: "object",
              required: ["event", "data"],
              properties: { event: { const: "added" }, data: { type: "string" } },
            },
            {
              type: "object",
              required: ["event", "data"],
              properties: { event: { const: "removed" }, data: { type: "string", enum: ["gone"] } },
            },
          ],
        },
      },
    },
  }
  const json = {
    description: "json",
    content: { "application/json": { schema: { type: "number" } } },
  }
  const { code, diagnostics } = await generate(
    oas("3.2", {
      paths: {
        "/events/{id}": {
          post: {
            parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["topic"],
                    properties: { topic: { type: "string" } },
                  },
                },
              },
            },
            responses: { "200": sse, 400: json },
          },
        },
        "/mixed": {
          get: { responses: { "200": { ...sse, content: { ...sse.content, ...json.content } } } },
        },
        "/impossible": {
          get: {
            responses: {
              "200": {
                description: "no valid data",
                content: {
                  "text/event-stream": { schema: { type: "string", enum: [] } },
                },
              },
            },
          },
        },
        "/fallback": { get: { responses: { default: sse } } },
        "/ordinary": { get: { responses: { "200": json, "default": sse } } },
        "/error-only": { get: { responses: { 400: sse } } },
        "/empty": { get: { responses: { 204: sse, 205: sse } } },
        "/head": { head: { responses: { "200": sse } } },
        "/range": { get: { responses: { "2XX": sse, 200: json } } },
        "/shadowed": {
          get: {
            responses: {
              "2XX": sse,
              ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [200 + i, json])),
            },
          },
        },
        "/wildcard": {
          get: { responses: { "200": { description: "wild", content: { "text/*": {} } } } },
        },
      },
    }),
  )
  expect(diagnostics).toStrictEqual([])
  const contract = await contractOf(code)
  expect(contract.endpoints["GET /ordinary"]).toStrictEqual({})
  expect(contract.endpoints["GET /mixed"]).toStrictEqual({
    stream: ["Text/Event-Stream; charset=utf-8"],
  })
  const streams = Object.entries(contract.endpoints)
    .filter(([, entry]) => entry.stream !== undefined)
    .map(([key]) => key)
  expect(streams.toSorted()).toStrictEqual([
    "GET /fallback",
    "GET /impossible",
    "GET /mixed",
    "GET /range",
    "POST /events/{id}",
  ])
  expect(
    await typecheck(
      {
        "api.ts": code,
        "use.ts": `
import { createClient } from "openapi-shape/client"
import type { Client, EndpointData, EndpointMessage, ResultEndpoint, StreamEndpoint, StreamArgs } from "openapi-shape/client"
import { contract, type Endpoints } from "./api"
const api = createClient(contract)
const keys: StreamEndpoint<Endpoints>[] = ["GET /fallback", "GET /mixed", "GET /range", "POST /events/{id}"]
void api.stream("GET /impossible")
// @ts-expect-error SSE classification is independent of its schema admitting values
void api.result("GET /impossible")
for await (const event of api.stream("POST /events/{id}", { params: { id: 1 }, body: { topic: "orders" } })) {
  event.data satisfies string
  event.event satisfies "added" | "removed"
  if (event.event === "removed") event.data satisfies "gone"
}
// @ts-expect-error required inputs
void api.stream("POST /events/{id}")
// @ts-expect-error wrong path parameter
void api.stream("POST /events/{id}", { params: { id: "wrong" }, body: { topic: "orders" } })
// @ts-expect-error a stream request body cannot be replayed
void api.stream("POST /events/{id}", { params: { id: 1 }, body: new ReadableStream() })
// @ts-expect-error result excludes streams
void api.result("GET /mixed")
// @ts-expect-error data is for result endpoints
type Invalid = EndpointData<Endpoints, "GET /mixed">
// @ts-expect-error ordinary endpoints do not stream
void api.stream("GET /ordinary")
// @ts-expect-error unknown endpoint
void api.stream("GET /missing")
// @ts-expect-error a call cannot mix endpoints
void api.stream(Math.random() ? "GET /mixed" : "GET /fallback")
void api.fetch("GET /mixed")
${["ordinary", "error-only", "empty", "head", "shadowed", "wildcard"]
  .map(
    (name) => `
void api.result("${name === "head" ? "HEAD" : "GET"} /${name}")
// @ts-expect-error not a stream
void api.stream("${name === "head" ? "HEAD" : "GET"} /${name}")`,
  )
  .join("\n")}
function wrap<K extends StreamEndpoint<Endpoints>>(key: K, ...args: StreamArgs<Endpoints, K>) { return api.stream(key, ...args) }
void wrap("GET /mixed")
type E = EndpointMessage<Endpoints, "GET /mixed">
declare const message: E
message.data satisfies string
`,
      },
      { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
    ),
  ).toBe("")
  const api = createClient(contract, {
    baseUrl: "https://example.test",
    fetch: () => Promise.resolve(response("event: removed\ndata: gone\n\n")),
  })
  const messages: StreamMessage[] = []
  // contractOf intentionally erases compile-time endpoints; the generated consumer above checks them.
  for await (const event of api.stream(
    "POST /events/{id}" as never,
    { params: { id: 3 }, body: { topic: "orders" }, retry: false } as never,
  ))
    messages.push(event as StreamMessage)
  expect(messages).toStrictEqual([{ event: "removed", data: "gone", id: "" }])
})

describe("native stream consumption", () => {
  it("connects only on read demand and snapshots a replayable request at first demand", async () => {
    const sent: Request[] = []
    const api = client({
      fetch: (request) => {
        sent.push(request)
        return Promise.resolve(response("data: first\n\ndata: second\n\n"))
      },
    })
    const input = { topic: "before" }
    const stream = api.stream("POST /events/{id}", {
      params: { id: 42 },
      body: input,
      retry: false,
    })
    expect(stream).toBeInstanceOf(ReadableStream)
    const reader = stream.getReader()
    await Promise.resolve()
    expect(sent).toHaveLength(0)
    input.topic = "at-first-read"
    expect(await reader.read()).toMatchObject({ value: { data: "first" }, done: false })
    expect(sent[0].url).toBe("https://example.test/events/42")
    expect(sent[0].headers.get("accept")).toBe("text/event-stream")
    expect(await sent[0].json()).toStrictEqual({ topic: "at-first-read" })
    expect(await reader.read()).toMatchObject({ value: { data: "second" } })
    expect(await reader.read()).toStrictEqual({ value: undefined, done: true })
    reader.releaseLock()
  })

  it("does not parse later fields in the same chunk until the next read", async () => {
    const state = { id: "", retry: 1000 }
    const iterator = readEvents(
      bytes([
        new TextEncoder().encode("id: first\ndata: one\n\nretry: 25\nid: second\ndata: two\n\n"),
      ]),
      state,
      new AbortController().signal,
    )
    expect(await iterator.next()).toMatchObject({ value: { data: "one", id: "first" } })
    expect(state).toStrictEqual({ id: "first", retry: 1000 })
    expect(await iterator.next()).toMatchObject({ value: { data: "two", id: "second" } })
    expect(state).toStrictEqual({ id: "second", retry: 25 })
    await iterator.return(undefined)
  })

  it("passes pipe backpressure to application reads and cancels when the destination fails", async () => {
    const cancel = vi.fn<() => void>()
    let reads = 0
    const api = client({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream(
              {
                pull(controller) {
                  reads++
                  controller.enqueue(new TextEncoder().encode(`data: ${reads}\n\n`))
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    })
    const gate = Promise.withResolvers<void>()
    const writing = Promise.withResolvers<void>()
    const failure = new Error("destination failed")
    const piped = api.stream("GET /events").pipeTo(
      new WritableStream({
        async write() {
          writing.resolve()
          await gate.promise
          throw failure
        },
      }),
      { preventAbort: false },
    )
    const rejected = piped.catch((error: unknown) => error)
    await writing.promise
    await Promise.resolve()
    expect(reads).toBe(1)
    gate.resolve()
    expect(await rejected).toBe(failure)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("composes through TransformStream and early for-await exit cancels the body", async () => {
    const cancel = vi.fn<() => void>()
    const api = client({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: one\n\ndata: two\n\n"))
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    })
    const values: string[] = []
    const transformed = api.stream("GET /events").pipeThrough(
      new TransformStream<StreamMessage, string>({
        transform(event, controller) {
          controller.enqueue(event.data)
        },
      }),
    )
    for await (const value of transformed) {
      values.push(value)
      break
    }
    expect(values).toStrictEqual(["one"])
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("uses standard reader locking and releaseLock does not cancel a subscription", async () => {
    const cancel = vi.fn<() => void>()
    const api = client({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: one\n\ndata: two\n\n"))
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    })
    const stream = api.stream("GET /events")
    const reader = stream.getReader()
    await expect(stream.cancel()).rejects.toBeInstanceOf(TypeError)
    await reader.read()
    reader.releaseLock()
    expect(cancel).not.toHaveBeenCalled()
    const next = stream.getReader()
    expect(await next.read()).toMatchObject({ value: { data: "two" } })
    await next.cancel()
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe("SSE reconnection", () => {
  it("replays fixed bytes through fresh middleware and resumes only a completed event ID", async () => {
    vi.useFakeTimers()
    const seen: Array<{ body: string; auth: string | null; id: string | null }> = []
    let authentication = 0
    const api = client({
      middleware: [
        (request, next) => {
          const authorized = new Request(request)
          authorized.headers.set("authorization", `token-${++authentication}`)
          return next(authorized)
        },
      ],
      fetch: async (request) => {
        seen.push({
          body: await request.text(),
          auth: request.headers.get("authorization"),
          id: request.headers.get("last-event-id"),
        })
        return seen.length === 1
          ? new Response(
              bytes(
                [new TextEncoder().encode("id: 雪é😀\nretry: 20\ndata: first\n\nid: unfinished\n")],
                new Error("socket"),
              ),
              { headers: { "content-type": "text/event-stream" } },
            )
          : response("data: second\n\n")
      },
    })
    const input = { topic: "original" }
    const reader = api
      .stream("POST /events/{id}", { params: { id: 1 }, body: input, retry: { maxRetries: 1 } })
      .getReader()
    expect(await reader.read()).toMatchObject({ value: { data: "first" } })
    input.topic = "changed"
    const second = reader.read()
    await vi.advanceTimersByTimeAsync(19)
    expect(seen).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await second).toMatchObject({ value: { data: "second", id: "雪é😀" } })
    const encodedId = String.fromCharCode(...new TextEncoder().encode("雪é😀"))
    expect(seen).toStrictEqual([
      { body: '{"topic":"original"}', auth: "token-1", id: null },
      { body: '{"topic":"original"}', auth: "token-2", id: encodedId },
    ])
    expect(await reader.read()).toMatchObject({ done: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reconnects after normal EOF and clears a caller-provided cursor", async () => {
    vi.useFakeTimers()
    const ids: Array<string | null> = []
    const api = client({
      fetch: (request) => {
        ids.push(request.headers.get("last-event-id"))
        return Promise.resolve(
          ids.length === 1 ? response("id:\n\ndata: one\n\n") : new Response(null, { status: 204 }),
        )
      },
    })
    const reader = api
      .stream("GET /events", { headers: { "Last-Event-ID": "initial" }, retry: { delay: 5 } })
      .getReader()
    await reader.read()
    const end = reader.read()
    await vi.advanceTimersByTimeAsync(5)
    expect(await end).toMatchObject({ done: true })
    expect(ids).toStrictEqual(["initial", null])
  })

  it.each([408, 429, 500, 503, 599])(
    "retries HTTP %s but stops normally on 204",
    async (status) => {
      vi.useFakeTimers()
      const cancel = vi.fn<() => void>()
      const fetch = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
      const reader = client({ fetch })
        .stream("GET /events", { retry: { delay: 10 } })
        .getReader()
      const end = reader.read()
      await vi.advanceTimersByTimeAsync(10)
      expect(await end).toMatchObject({ done: true })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it("retries transport failure, without resetting a lifetime retry budget on successful connections", async () => {
    vi.useFakeTimers()
    const failure = new Error("network")
    const fetch = vi
      .fn<Fetcher>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(response("data: recovered\n\n"))
      .mockRejectedValue(failure)
    const reader = client({ fetch })
      .stream("GET /events", { retry: { delay: 10, maxRetries: 1 } })
      .getReader()
    const first = reader.read()
    await vi.advanceTimersByTimeAsync(10)
    expect(await first).toMatchObject({ value: { data: "recovered" } })
    expect(await reader.read()).toMatchObject({ done: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([false, { maxRetries: 0 }] as const)("does not retry with %j", async (retry) => {
    const failure = new Error("network")
    const fetch = vi.fn<Fetcher>().mockRejectedValue(failure)
    await expect(
      client({ fetch }).stream("GET /events", { retry }).getReader().read(),
    ).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledOnce()
    const finite = client({ fetch: () => Promise.resolve(response()) }).stream("GET /events", {
      retry,
    })
    const values: StreamMessage[] = []
    for await (const value of finite) values.push(value)
    expect(values).toStrictEqual([{ event: "message", data: "hello", id: "" }])
  })

  it("reports the last actual failure when retries are exhausted", async () => {
    vi.useFakeTimers()
    const first = new Error("first")
    const last = new Error("last")
    const fetch = vi.fn<Fetcher>().mockRejectedValueOnce(first).mockRejectedValue(last)
    const end = client({ fetch })
      .stream("GET /events", { retry: { delay: 10, maxRetries: 1 } })
      .getReader()
      .read()
    const rejected = end.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    expect(await rejected).toBe(last)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("uses Retry-After for one attempt and then the server-supplied SSE interval", async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(response("retry: 7\ndata: one\n\n"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const reader = client({ fetch }).stream("GET /events").getReader()
    const first = reader.read()
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(await first).toMatchObject({ value: { data: "one" } })
    const end = reader.read()
    await vi.advanceTimersByTimeAsync(6)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await end).toMatchObject({ done: true })
  })

  it.each([400, 401, 403, 404])(
    "terminates HTTP %s and preserves status/headers while canceling the body",
    async (status) => {
      const cancel = vi.fn<() => void>()
      const received = new Response(new ReadableStream({ cancel }), {
        status,
        headers: { "x-error": "present" },
      })
      const fetch = vi.fn<Fetcher>().mockResolvedValue(received)
      const failure = await client({ fetch })
        .stream("GET /events")
        .getReader()
        .read()
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(StreamResponseError)
      expect((failure as StreamResponseError).response.headers.get("x-error")).toBe("present")
      expect((failure as StreamResponseError).response.status).toBe(status)
      expect(fetch).toHaveBeenCalledOnce()
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(["application/json", "text/event-streaming", ""])(
    "rejects a mismatched response media %j",
    async (media) => {
      const fetch = vi
        .fn<Fetcher>()
        .mockResolvedValue(new Response("data", { headers: { "content-type": media } }))
      await expect(
        client({ fetch }).stream("GET /events").getReader().read(),
      ).rejects.toBeInstanceOf(StreamResponseError)
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  it("rejects missing or middleware-consumed bodies without retry", async () => {
    for (const received of [
      new Response(null, { headers: { "content-type": "text/event-stream" } }),
      response(),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- prepare one invalid body state at a time
      if (received.body) await received.text()
      const fetch = vi.fn<Fetcher>().mockResolvedValue(received)
      // oxlint-disable-next-line no-await-in-loop -- each response is a distinct invalid body state
      await expect(
        client({ fetch }).stream("GET /events").getReader().read(),
      ).rejects.toBeInstanceOf(StreamResponseError)
      expect(fetch).toHaveBeenCalledOnce()
    }
  })

  it("does not retry a middleware error and disposes a response obtained before that error", async () => {
    const failure = new TypeError("middleware bug")
    const cancel = vi.fn<() => void>()
    const fetch = vi.fn<Fetcher>().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/event-stream" },
      }),
    )
    const api = client({
      fetch,
      middleware: [
        async (request, next) => {
          await next(request)
          throw failure
        },
      ],
    })
    await expect(api.stream("GET /events").getReader().read()).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    const before = client({
      fetch,
      middleware: [
        () => {
          throw failure
        },
      ],
    })
    await expect(before.stream("GET /events").getReader().read()).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    { delay: -1 },
    { delay: Number.NaN },
    { delay: Infinity },
    { delay: 0.5 },
    { maxRetries: -1 },
    { maxRetries: Infinity },
    { maxRetries: 0.5 },
  ])("reports invalid retry options %j through the stream", async (retry) => {
    const fetch = vi.fn<Fetcher>()
    const stream = client({ fetch }).stream("GET /events", { retry })
    await expect(stream.getReader().read()).rejects.toBeInstanceOf(TypeError)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("subscription cancellation", () => {
  it("can cancel before first demand without sending any request", async () => {
    const fetch = vi.fn<Fetcher>()
    const stream = client({ fetch }).stream("GET /events")
    await stream.cancel("unused")
    await stream.cancel("again")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("errors an already-aborted stream with its exact reason without transport", async () => {
    const reason = { kind: "stop" }
    const fetch = vi.fn<Fetcher>()
    const stream = client({ fetch }).stream("GET /events", { signal: AbortSignal.abort(reason) })
    await expect(stream.getReader().read()).rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("aborts a pending fetch promptly and disposes its late response", async () => {
    const pending = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<Request>()
    const cancel = vi.fn<() => void>()
    const signal = new AbortController()
    const reader = client({
      fetch: (request) => {
        started.resolve(request)
        return pending.promise
      },
    })
      .stream("GET /events", { signal: signal.signal })
      .getReader()
    const read = reader.read()
    const rejected = read.catch((error: unknown) => error)
    const request = await started.promise
    signal.abort(new Error("shutdown"))
    expect(await rejected).toMatchObject({ message: "shutdown" })
    expect(request.signal.aborted).toBe(true)
    pending.resolve(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/event-stream" },
      }),
    )
    await pending.promise
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(["signal", "reader"])(
    "interrupts a pending body read using %s cancellation",
    async (kind) => {
      const reading = Promise.withResolvers<void>()
      const cancel = vi.fn<() => void>()
      const signal = new AbortController()
      const reader = client({
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream(
                {
                  pull() {
                    reading.resolve()
                  },
                  cancel,
                },
                { highWaterMark: 0 },
              ),
              { headers: { "content-type": "text/event-stream" } },
            ),
          ),
      })
        .stream("GET /events", { signal: signal.signal })
        .getReader()
      const pending = reader.read()
      const observed = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await reading.promise
      if (kind === "signal") signal.abort(new Error("stop"))
      else await reader.cancel("stop")
      expect(await observed).toMatchObject(
        kind === "signal" ? { error: { message: "stop" } } : { value: { done: true } },
      )
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it("errors immediately on external abort while no pull is pending", async () => {
    const signal = new AbortController()
    const cancel = vi.fn<() => void>()
    const reader = client({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: one\n\n"))
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    })
      .stream("GET /events", { signal: signal.signal })
      .getReader()
    await reader.read()
    const reason = new Error("paused abort")
    const closed = reader.closed.catch((error: unknown) => error)
    signal.abort(reason)
    expect(await closed).toBe(reason)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("clears a retry wait and never starts another request", async () => {
    vi.useFakeTimers()
    const failure = new Error("offline")
    const fetch = vi.fn<Fetcher>().mockRejectedValue(failure)
    const signal = new AbortController()
    const reader = client({ fetch }).stream("GET /events", { signal: signal.signal }).getReader()
    const read = reader.read()
    const rejected = read.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    signal.abort(new Error("stop"))
    expect(await rejected).toMatchObject({ message: "stop" })
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("follows pipeTo cancellation and cleans up a suspended parser", async () => {
    const cancel = vi.fn<() => void>()
    const signal = new AbortController()
    const written = Promise.withResolvers<void>()
    const api = client({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: one\n\n"))
              },
              cancel,
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    })
    const piped = api.stream("GET /events").pipeTo(
      new WritableStream({
        write() {
          written.resolve()
        },
      }),
      { signal: signal.signal },
    )
    const rejected = piped.catch((error: unknown) => error)
    await written.promise
    signal.abort(new Error("stop piping"))
    expect(await rejected).toMatchObject({ message: "stop piping" })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects invalid endpoint/request input through the stream while fetch remains available", async () => {
    const fetch = vi.fn<Fetcher>().mockImplementation(() => Promise.resolve(response()))
    const api = client({ fetch })
    await expect(
      api
        .stream("GET /ordinary" as never)
        .getReader()
        .read(),
    ).rejects.toThrow("does not declare")
    await expect(
      api
        .stream("POST /events/{id}", { params: { id: 1 }, body: new ReadableStream() as never })
        .getReader()
        .read(),
    ).rejects.toThrow("cannot replay")
    await expect(
      api
        .stream("POST /events/{id}", { body: { topic: "a" } } as never)
        .getReader()
        .read(),
    ).rejects.toThrow()
    await expect(api.result("GET /events" as never)).rejects.toThrow("requires api.stream")
    expect(fetch).not.toHaveBeenCalled()
    const received = await api.fetch("GET /events")
    expect(await received.text()).toBe("data: hello\n\n")
  })
})

it("retires an unused middleware clone branch before a subscription ends", async () => {
  const original = response("data: live\n\n")
  const api = client({
    fetch: () => Promise.resolve(original),
    middleware: [
      async (request, next) => {
        const received = await next(request)
        return received.clone()
      },
    ],
  })
  const reader = api.stream("GET /events").getReader()
  expect(await reader.read()).toMatchObject({ value: { data: "live" } })
  const unused = original.body?.getReader()
  expect(await unused?.read()).toMatchObject({ done: true })
  unused?.releaseLock()
  await reader.cancel()
})

it("cleans responses when abort races every transport completion boundary", async () => {
  for (let offset = 0; offset < 16; offset++) {
    const signal = new AbortController()
    const cancel = vi.fn<() => void>()
    const received = new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "text/event-stream" },
    })
    const api = client({
      fetch: () => {
        let remaining = offset
        const abort = (): void => {
          if (remaining-- === 0) signal.abort(new Error("racing stop"))
          else queueMicrotask(abort)
        }
        queueMicrotask(abort)
        return Promise.resolve(received)
      },
    })
    // oxlint-disable-next-line no-await-in-loop -- each independent subscription races a different boundary
    await expect(
      api.stream("GET /events", { signal: signal.signal }).getReader().read(),
    ).rejects.toThrow("racing stop")
    // oxlint-disable-next-line no-await-in-loop -- wait for the late response's cleanup before the next case
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  }
})

it("does not reconnect when reader cancellation wins the retry timer boundary", async () => {
  vi.useFakeTimers()
  const fetch = vi.fn<Fetcher>().mockRejectedValue(new Error("offline"))
  const reader = client({ fetch })
    .stream("GET /events", { retry: { delay: 10 } })
    .getReader()
  const pending = reader.read()
  await vi.advanceTimersByTimeAsync(9)
  await reader.cancel("done")
  expect(await pending).toMatchObject({ done: true })
  await vi.advanceTimersByTimeAsync(100)
  expect(fetch).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  "Wed, 01 Jan 2025 00:00:02 GMT",
  "Wednesday, 01-Jan-25 00:00:02 GMT",
  "Wed Jan  1 00:00:02 2025",
  "bad",
  "-1",
  "9007199254740991000",
])("handles Retry-After %j without overriding the initial interval", async (header) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"))
  const delay = header.startsWith("Wed") ? 2000 : 1000
  const fetch = vi
    .fn<Fetcher>()
    .mockResolvedValueOnce(new Response(null, { status: 503, headers: { "Retry-After": header } }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  const pending = client({ fetch }).stream("GET /events").getReader().read()
  await vi.advanceTimersByTimeAsync(delay - 1)
  expect(fetch).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toMatchObject({ done: true })
})

it("splits a server retry interval above the JavaScript timer limit", async () => {
  vi.useFakeTimers()
  const fetch = vi
    .fn<Fetcher>()
    .mockResolvedValueOnce(response("retry: 2147483657\ndata: first\n\n"))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  const reader = client({ fetch }).stream("GET /events").getReader()
  await reader.read()
  const pending = reader.read()
  await vi.advanceTimersByTimeAsync(2147483647)
  expect(fetch).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(9)
  expect(fetch).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toMatchObject({ done: true })
})
