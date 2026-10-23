import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClientOptions, Fetcher, StreamMessage } from "../src/client"
import { createClient, StreamResponseError } from "../src/client"
import { readEvents } from "../src/client/sse"
import { generate } from "../src/core/index"
import { contractOf } from "./helpers/contract"
import { oas } from "./helpers/generate"
import { typecheck } from "./helpers/tsc"

function client(options: ClientOptions = {}) {
  return createClient<{
    "GET /events": { responses: { "200": { content: { "text/event-stream": string } } } }
    "POST /events/{id}": {
      params: { id: number }
      body: { "application/json": { topic: string } }
      responses: { "200": { content: { "text/event-stream": string } } }
    }
    "GET /ordinary": { responses: { "200": { content: { "application/json": number } } } }
  }>(
    {
      version: 4,
      endpoints: { "GET /events": { stream: "sse" }, "POST /events/{id}": { stream: "sse" } },
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

describe("stream lifecycle", () => {
  it("awaits callbacks in order, reuses request encoding, and finishes at EOF", async () => {
    const order: string[] = []
    const api = client({
      fetch: async (request) => {
        expect(request.url).toBe("https://example.test/events/42")
        expect(request.headers.get("accept")).toBe("text/event-stream")
        expect(await request.json()).toStrictEqual({ topic: "orders" })
        return response("data: first\n\ndata: second\n\n")
      },
    })
    await api.stream("POST /events/{id}", {
      params: { id: 42 },
      body: { topic: "orders" },
      onOpen: () => {
        order.push("open")
      },
      onMessage: async (event) => {
        await Promise.resolve()
        order.push(event.data)
      },
      onClose: () => {
        order.push("close")
      },
    })
    expect(order).toStrictEqual(["open", "first", "second", "close"])
  })

  it("replays a fixed body through middleware and resumes after a read failure", async () => {
    vi.useFakeTimers()
    const body = { topic: "original" }
    const seen: Array<{ body: unknown; id: string | null; auth: string | null }> = []
    let wraps = 0
    const api = client({
      middleware: [
        async (request, next) => {
          wraps++
          const changed = new Request(request)
          changed.headers.set("authorization", `token-${wraps}`)
          return await next(changed)
        },
      ],
      fetch: async (request) => {
        seen.push({
          body: await request.json(),
          id: request.headers.get("last-event-id"),
          auth: request.headers.get("authorization"),
        })
        body.topic = "mutated"
        if (seen.length === 1)
          return new Response(
            bytes(
              [new TextEncoder().encode("id: 42\nretry: 20\ndata: first\n\nid: unfinished\n")],
              new Error("disconnect"),
            ),
            { headers: { "content-type": "text/event-stream" } },
          )
        return response()
      },
    })
    const messages: string[] = []
    const pending = api.stream("POST /events/{id}", {
      params: { id: 1 },
      body,
      onMessage: (event) => {
        messages.push(event.data)
      },
    })
    await vi.advanceTimersByTimeAsync(19)
    expect(seen).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(messages).toStrictEqual(["first", "hello"])
    expect(seen).toStrictEqual([
      { body: { topic: "original" }, id: null, auth: "token-1" },
      { body: { topic: "original" }, id: "42", auth: "token-2" },
    ])
  })

  it("encodes Unicode resume IDs as UTF-8 bytes", async () => {
    vi.useFakeTimers()
    const ids: Array<string | null> = []
    const messages: StreamMessage[] = []
    const api = client({
      fetch: (request) => {
        ids.push(request.headers.get("last-event-id"))
        return Promise.resolve(response("id: 雪é😀\ndata: one\n\n"))
      },
    })
    const pending = api.stream("GET /events", {
      headers: { "last-event-id": "\xc3\xa9" },
      onMessage: (event) => {
        messages.push(event)
      },
      onClose() {
        if (ids.length === 1) throw new Error("reopen")
      },
      onError: () => 0,
    })
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(ids).toStrictEqual(["\xc3\xa9", "\xe9\x9b\xaa\xc3\xa9\xf0\x9f\x98\x80"])
    expect(messages.map((event) => event.id)).toStrictEqual(["雪é😀", "雪é😀"])
  })

  it("clears an initial cursor and supports explicit retry after normal EOF", async () => {
    vi.useFakeTimers()
    const ids: Array<string | null> = []
    const api = client({
      fetch: (request) => {
        ids.push(request.headers.get("last-event-id"))
        return Promise.resolve(response("id:\n\ndata: one\n\n"))
      },
    })
    const pending = api.stream("GET /events", {
      headers: { "Last-Event-ID": "initial" },
      onClose() {
        if (ids.length === 1) throw new Error("reopen")
      },
      onError: () => 5,
    })
    await vi.advanceTimersByTimeAsync(5)
    await pending
    expect(ids).toStrictEqual(["initial", null])
  })

  it.each([408, 429, 500, 503])("retries HTTP %s by default", async (status) => {
    vi.useFakeTimers()
    const transport = vi
      .fn<Fetcher>()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(response())
    const pending = client({ fetch: transport }).stream("GET /events")
    await vi.advanceTimersByTimeAsync(999)
    expect(transport).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 404])("stops on HTTP %s and retains the response", async (status) => {
    const received = new Response("denied", { status })
    const transport = vi.fn<Fetcher>().mockResolvedValue(received)
    const pending = client({ fetch: transport }).stream("GET /events")
    await expect(pending).rejects.toMatchObject({ name: "StreamResponseError", response: received })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(received.bodyUsed).toBe(true)
  })

  it.each(["application/json", "text/event-streaming", ""])(
    "rejects invalid content type %s",
    async (contentType) => {
      const api = client({
        fetch: () =>
          Promise.resolve(new Response("{}", { headers: { "content-type": contentType } })),
      })
      await expect(api.stream("GET /events")).rejects.toBeInstanceOf(StreamResponseError)
    },
  )

  it("finishes at 204 and rejects missing SSE bodies", async () => {
    const close = vi.fn<() => void>()
    await client({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }).stream(
      "GET /events",
      { onClose: close },
    )
    expect(close).toHaveBeenCalledOnce()
    await expect(
      client({
        fetch: () =>
          Promise.resolve(new Response(null, { headers: { "content-type": "text/event-stream" } })),
      }).stream("GET /events"),
    ).rejects.toThrow("with a body")
  })

  it("does not retry callback errors unless explicitly requested", async () => {
    const failure = new Error("consumer")
    const transport = vi.fn<Fetcher>().mockImplementation(() => Promise.resolve(response()))
    await expect(
      client({ fetch: transport }).stream("GET /events", {
        onMessage: () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(transport).toHaveBeenCalledOnce()
    await expect(
      client({ fetch: () => Promise.reject(failure) }).stream("GET /events", {
        onError: () => false,
      }),
    ).rejects.toBe(failure)
    await expect(
      client({ fetch: () => Promise.reject(failure) }).stream("GET /events", { onError: () => -1 }),
    ).rejects.toThrow("retry delay")
  })

  it("rejects already canceled calls without invoking transport", async () => {
    const transport = vi.fn<Fetcher>()
    const reason = new Error("stop")
    await expect(
      client({ fetch: transport }).stream("GET /events", { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason)
    expect(transport).not.toHaveBeenCalled()
  })

  it("cancels a blocked reader and prevents retries", async () => {
    const controller = new AbortController()
    const cancel = vi.fn<() => void>()
    const transport = vi.fn<Fetcher>().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/event-stream" },
      }),
    )
    const opened = Promise.withResolvers<void>()
    const pending = client({ fetch: transport }).stream("GET /events", {
      signal: controller.signal,
      onOpen: () => {
        opened.resolve()
      },
    })
    const checked = pending.catch((error: unknown) => error)
    await opened.promise
    controller.abort(new Error("stop"))
    expect(await checked).toMatchObject({ message: "stop" })
    expect(cancel).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenCalledOnce()
  })

  it("cancels during an unresolved callback without delivering another event", async () => {
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const onMessage = vi.fn<() => Promise<void>>(() => {
      entered.resolve()
      return new Promise<void>(() => {
        /* Consumer deliberately never settles. */
      })
    })
    const pending = client({
      fetch: () => Promise.resolve(response("data: a\n\ndata: b\n\n")),
    }).stream("GET /events", { signal: controller.signal, onMessage })
    const checked = pending.catch((error: unknown) => error)
    await entered.promise
    controller.abort(new Error("stop"))
    expect(await checked).toMatchObject({ message: "stop" })
    expect(onMessage).toHaveBeenCalledOnce()
  })

  it("disposes responses when abort races transport completion", async () => {
    for (let offset = 0; offset < 12; offset++) {
      const controller = new AbortController()
      const cancel = vi.fn<() => void>()
      const received = new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/event-stream" },
      })
      const schedule = (remaining: number): void => {
        queueMicrotask(() => {
          if (remaining === 0) controller.abort(new Error("stop"))
          else schedule(remaining - 1)
        })
      }
      const pending = client({
        fetch: () => {
          schedule(offset)
          return Promise.resolve(received)
        },
      }).stream("GET /events", { signal: controller.signal })
      // oxlint-disable-next-line no-await-in-loop -- each offset exercises a different cancellation boundary
      await expect(pending).rejects.toThrow("stop")
      expect(cancel, `microtask offset ${offset}`).toHaveBeenCalledOnce()
      expect(received.body?.locked).toBe(false)
    }
  })

  it("cancels retry waits and late transport responses", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const transport = vi.fn<Fetcher>().mockRejectedValue(new Error("offline"))
    const pending = client({ fetch: transport }).stream("GET /events", {
      signal: controller.signal,
    })
    const checked = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error("stop"))
    expect(await checked).toMatchObject({ message: "stop" })
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    const late = Promise.withResolvers<Response>()
    const second = new AbortController()
    const waiting = client({ fetch: () => late.promise }).stream("GET /events", {
      signal: second.signal,
    })
    const rejected = waiting.catch((error: unknown) => error)
    second.abort(new Error("stop"))
    expect(await rejected).toMatchObject({ message: "stop" })
    const received = response()
    late.resolve(received)
    await Promise.resolve()
    await Promise.resolve()
    expect(received.bodyUsed).toBe(true)
  })

  it("checks method selection and one-shot bodies before sending", async () => {
    const transport = vi.fn<Fetcher>().mockImplementation(() => Promise.resolve(response()))
    const api = client({ fetch: transport })
    await expect(api.result("GET /events" as never)).rejects.toThrow("requires api.stream")
    await expect(api.stream("GET /ordinary" as never)).rejects.toThrow("does not declare")
    await expect(
      api.stream("POST /events/{id}", { params: { id: 1 }, body: new ReadableStream() as never }),
    ).rejects.toThrow("cannot replay")
    expect(transport).not.toHaveBeenCalled()
    const received = await api.fetch("GET /events")
    expect(await received.text()).toBe("data: hello\n\n")
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
  const streams = Object.entries(contract.endpoints)
    .filter(([, entry]) => entry?.stream === "sse")
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
void api.stream("POST /events/{id}", { params: { id: 1 }, body: { topic: "orders" }, onMessage(event) {
  event.data satisfies string
  event.event satisfies "added" | "removed"
  if (event.event === "removed") event.data satisfies "gone"
} })
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
  await api.stream(
    "POST /events/{id}" as never,
    {
      params: { id: 3 },
      body: { topic: "orders" },
      onMessage: (event: StreamMessage) => {
        messages.push(event)
      },
    } as never,
  )
  expect(messages).toStrictEqual([{ event: "removed", data: "gone", id: "" }])
})
