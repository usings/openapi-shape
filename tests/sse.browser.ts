import { afterEach, describe, expect, it, vi } from "vitest"
import type { Fetcher, MiddlewareContext, StreamMessage } from "../src/client"
import { StreamResponseError } from "../src/client"
import { readEvents } from "../src/client/sse-parser"
import { sseClient as client, sseResponse as response } from "./helpers/streams"

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

describe("SSE parser", () => {
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
})

describe("SSE connections", () => {
  afterEach(() => vi.useRealTimers())

  it("snapshots the call baseURL on first demand and reuses it when reconnecting", async () => {
    const requests: Request[] = []
    const api = client({
      fetch: (request) => {
        requests.push(request)
        return Promise.resolve(
          requests.length === 1 ? response() : new Response(null, { status: 204 }),
        )
      },
    })
    const baseURL = new URL("https://events.test/v1/")
    const events = api.stream("GET /events", { baseURL, retry: { delay: 0, maxRetries: 1 } })
    const reader = events.getReader()
    expect(requests).toHaveLength(0)
    baseURL.pathname = "/v2/"
    expect(await reader.read()).toMatchObject({ value: { data: "hello" } })
    baseURL.hostname = "changed.test"
    baseURL.pathname = "/changed"
    expect(await reader.read()).toMatchObject({ done: true })
    reader.releaseLock()
    await api.fetch("GET /ordinary")
    expect(requests.map((request) => request.url)).toStrictEqual([
      "https://events.test/v2/events",
      "https://events.test/v2/events",
      "https://example.test/ordinary",
    ])
  })

  it("rejects an invalid call baseURL lazily without connecting", async () => {
    const fetch = vi.fn<Fetcher>()
    const events = client({ fetch }).stream("GET /events", {
      baseURL: "https://events.test/?token=x",
    })
    expect(fetch).not.toHaveBeenCalled()
    await expect(events.getReader().read()).rejects.toThrow("baseURL")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("replays fixed bytes through fresh middleware and resumes only a completed event ID", async () => {
    vi.useFakeTimers()
    const seen: Array<{ body: string; auth: string | null; id: string | null }> = []
    const contexts: MiddlewareContext[] = []
    let authentication = 0
    const api = client({
      middleware: [
        (request, next, context) => {
          contexts.push(context)
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
    expect(contexts).toStrictEqual([
      { endpoint: "POST /events/{id}", kind: "stream" },
      { endpoint: "POST /events/{id}", kind: "stream" },
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

  it("does not retry a middleware error after middleware disposes its response", async () => {
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
          const received = await next(request)
          await received.body?.cancel()
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

  it("does not retry an SSE decoder error caused by middleware response chunks", async () => {
    const fetch = vi.fn<Fetcher>().mockImplementation(() => Promise.resolve(new Response("unused")))
    const api = client({
      fetch,
      middleware: [
        async (request, next) => {
          await next(request)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue("not bytes")
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      ],
    })
    await expect(
      api
        .stream("GET /events", { retry: { delay: 0, maxRetries: 1 } })
        .getReader()
        .read(),
    ).rejects.toBeInstanceOf(TypeError)
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
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { "Retry-After": header } }),
      )
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
})
