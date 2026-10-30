import { afterEach, describe, expect, it, vi } from "vitest"
import type { Fetcher, StreamMessage } from "../../src/client"
import { sseClient as client, sseResponse as response } from "../support/streams"

afterEach(() => vi.useRealTimers())

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
      headers: { "content-type": "application/json" },
      params: { id: 42 },
      body: input,
      reconnect: false,
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

  it("clears a reconnect wait and never starts another request", async () => {
    vi.useFakeTimers()
    const failure = new Error("offline")
    const fetch = vi.fn<Fetcher>().mockRejectedValue(failure)
    const signal = new AbortController()
    const reader = client({ fetch })
      .stream("GET /events", {
        headers: { accept: "text/event-stream" },
        signal: signal.signal,
        reconnect: {},
      })
      .getReader()
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
})

it("keeps a middleware-owned clone branch readable after response handoff", async () => {
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
  expect(await unused?.read()).toMatchObject({
    value: new TextEncoder().encode("data: live\n\n"),
    done: false,
  })
  await Promise.all([unused?.cancel(), reader.cancel()])
  unused?.releaseLock()
})

it.each(["transport", "middleware", "reader"] as const)(
  "cleans the response when abort occurs at the %s boundary",
  async (boundary) => {
    const signal = new AbortController()
    const reason = new Error("boundary stop")
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const cancel = vi.fn<() => void>()
    const received = new Response(
      new ReadableStream(
        {
          pull() {
            if (boundary === "reader") entered.resolve()
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/event-stream" } },
    )
    const api = client({
      fetch: async () => {
        if (boundary === "transport") {
          entered.resolve()
          await proceed.promise
        }
        return received
      },
      middleware: [
        async (request, next) => {
          const delivered = await next(request)
          if (boundary === "middleware") {
            entered.resolve()
            await proceed.promise
          }
          return delivered
        },
      ],
    })
    const reader = api.stream("GET /events", { signal: signal.signal }).getReader()
    const read = reader.read()
    const outcome = read.catch((error: unknown) => error)
    await entered.promise
    signal.abort(reason)
    proceed.resolve()
    expect(await outcome).toBe(reason)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    reader.releaseLock()
  },
)

it("does not reconnect when reader cancellation wins the reconnect timer boundary", async () => {
  vi.useFakeTimers()
  const fetch = vi.fn<Fetcher>().mockRejectedValue(new Error("offline"))
  const reader = client({ fetch })
    .stream("GET /events", { headers: { accept: "text/event-stream" }, reconnect: { delay: 10 } })
    .getReader()
  const pending = reader.read()
  await vi.advanceTimersByTimeAsync(9)
  await reader.cancel("done")
  expect(await pending).toMatchObject({ done: true })
  await vi.advanceTimersByTimeAsync(100)
  expect(fetch).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
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
      .stream("POST /events/{id}", {
        headers: { "accept": "text/event-stream", "content-type": "application/json" },
        params: { id: 1 },
        body: new ReadableStream() as never,
        reconnect: {},
      })
      .getReader()
      .read(),
  ).rejects.toThrow("cannot replay")
  await expect(
    api
      .stream("POST /events/{id}", { body: { topic: "a" } } as never)
      .getReader()
      .read(),
  ).rejects.toThrow()
  await expect(api.result("GET /events" as never)).rejects.toMatchObject({
    code: "UNEXPECTED_MEDIA_TYPE",
  })
  expect(fetch).toHaveBeenCalledOnce()
  const received = await api.fetch("GET /events")
  expect(await received.text()).toBe("data: hello\n\n")
})
