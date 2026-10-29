import { describe, expect, it, vi } from "vitest"
import type { ClientOptions, Fetcher, StreamMessage } from "../../src/client"
import { createClient, StreamParseError } from "../../src/client"
import { sseClient, sseResponse } from "../support/streams"

const encoder = new TextEncoder()

function api(options: ClientOptions = {}) {
  return createClient<{
    "GET /data": { responses: { 200: { content: { "application/json": unknown } } } }
    "POST /records": {
      body: { "application/octet-stream": unknown }
      responses: { 200: { content: { "application/x-ndjson": number[] } } }
    }
  }>(
    {
      version: 7,
      endpoints: {
        "GET /data": { responses: { default: { content: { "*/*": {} } } } },
        "POST /records": {
          requestBody: { required: false, content: { "application/octet-stream": {} } },
          responses: {
            "200": {
              content: { "application/x-ndjson": {} },
            },
          },
        },
      },
    },
    { baseURL: "https://example.test", ...options },
  )
}

describe("Web stream lifecycle", () => {
  it.each([undefined, null, { stop: true }])(
    "preserves explicit NDJSON cancellation reason %j",
    async (reason) => {
      const cancel = vi.fn<(reason?: unknown) => void>()
      const client = api({
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encoder.encode("1\n"))
                },
                cancel,
              }),
              { headers: { "content-type": "application/x-ndjson" } },
            ),
          ),
      })
      const reader = client
        .stream("POST /records", {
          headers: { "content-type": "application/octet-stream" },
          body: "",
        })
        .getReader()
      await reader.read()
      await reader.cancel(reason)
      expect(cancel).toHaveBeenCalledOnce()
      expect(cancel.mock.calls[0]?.[0]).toBe(reason)
    },
  )

  it("delivers a parser failure without waiting for indefinite cleanup", async () => {
    const gate = Promise.withResolvers<void>()
    const client = api({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode("invalid\n"))
              },
              cancel() {
                return gate.promise
              },
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          ),
        ),
    })
    let failure: unknown
    const pending = client
      .stream("POST /records", {
        headers: { "content-type": "application/octet-stream" },
        body: "",
      })
      .getReader()
      .read()
      .catch((error: unknown) => {
        failure = error
      })
    try {
      await vi.waitFor(() => expect(failure).toBeInstanceOf(StreamParseError))
    } finally {
      gate.resolve()
      await pending
    }
  })

  it.each(
    ["paused", "reading"].flatMap((state) =>
      [undefined, null, new Error("consumer stopped")].map((reason) => ({ state, reason })),
    ),
  )(
    "propagates cancellation reason $reason and waits for cleanup while $state",
    async ({ state, reason }) => {
      const gate = Promise.withResolvers<void>()
      const cancel = vi.fn<(reason?: unknown) => Promise<void>>(() => gate.promise)
      const client = sseClient({
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encoder.encode("data: one\n\n"))
                },
                cancel,
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          ),
      })
      const reader = client.stream("GET /events", { retry: false }).getReader()
      await reader.read()
      const pending = state === "reading" ? reader.read() : undefined
      let finished = false
      const cancellation = reader.cancel(reason).then(() => {
        finished = true
      })
      try {
        await Promise.resolve()
        expect(cancel).toHaveBeenCalledOnce()
        expect(cancel.mock.calls[0]?.[0]).toBe(reason)
        expect(finished).toBe(false)
      } finally {
        gate.resolve()
        await cancellation
        await pending
      }
      expect(finished).toBe(true)
    },
  )

  it("reports explicit cancellation cleanup failure", async () => {
    const failure = new Error("cleanup failed")
    const reader = sseClient({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode("data: one\n\n"))
              },
              cancel() {
                return Promise.reject(failure)
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    })
      .stream("GET /events", { retry: false })
      .getReader()
    await reader.read()
    await expect(reader.cancel("stop")).rejects.toBe(failure)
  })

  it("does not turn normal EOF into request abort", async () => {
    let request: Request | undefined
    const client = sseClient({
      fetch: (sent) => {
        request = sent
        return Promise.resolve(sseResponse())
      },
    })
    const values: StreamMessage[] = []
    for await (const value of client.stream("GET /events", { retry: false })) values.push(value)
    expect(values).toHaveLength(1)
    expect(request?.signal.aborted).toBe(false)
  })

  it.each([false, { maxRetries: 0 }] as const)(
    "sends one-shot SSE uploads when retry is %j",
    async (retry) => {
      const sent = vi.fn<Fetcher>(async (request: Request) => {
        expect(await request.text()).toBe("upload")
        return sseResponse()
      })
      const client = sseClient({ fetch: sent })
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode("upload"))
          c.close()
        },
      })
      const reader = client
        .stream("POST /events/{id}", {
          headers: { accept: "text/event-stream" },
          params: { id: 1 },
          body,
          retry,
        })
        .getReader()
      expect(await reader.read()).toMatchObject({ value: { data: "hello" } })
      expect(await reader.read()).toMatchObject({ done: true })
      expect(sent).toHaveBeenCalledOnce()
    },
  )

  it("hands an unfinished NDJSON upload to transport before buffering it", async () => {
    const cancel = vi.fn<(reason?: unknown) => void>()
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })
    const sent = vi.fn<Fetcher>(async (request: Request) => {
      expect(request.body).not.toBeNull()
      await request.body?.cancel("not needed")
      return new Response("1\n", { headers: { "content-type": "application/x-ndjson" } })
    })
    const reader = api({ fetch: sent }).stream("POST /records", { body }).getReader()
    expect(await reader.read()).toMatchObject({ value: 1 })
    expect(await reader.read()).toMatchObject({ done: true })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel.mock.calls[0]?.[0]).toBe("not needed")
  })

  it("preserves a lazy middleware dependency on a different response stream", async () => {
    const client = api({
      fetch: () => Promise.resolve(new Response("payload")),
      middleware: [
        async (request, next) => {
          const original = await next(request)
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
          return new Response(
            new ReadableStream(
              {
                async pull(controller) {
                  reader ??= original.body?.getReader()
                  const value = await reader?.read()
                  if (!value || value.done) {
                    reader?.releaseLock()
                    controller.close()
                  } else controller.enqueue(value.value)
                },
                cancel(reason) {
                  return reader ? reader.cancel(reason) : original.body?.cancel(reason)
                },
              },
              { highWaterMark: 0 },
            ),
          )
        },
      ],
    })
    const response = await client.fetch("GET /data")
    expect(await response.text()).toBe("payload")
  })
})
