import { afterEach, expect, it, vi } from "vitest"
import type { Fetcher } from "../../src/client"
import { sseClient, sseResponse } from "../support/streams"

afterEach(() => vi.restoreAllMocks())

it.each(["stream", "iterable"] as const)(
  "preserves one-shot %s upload demand and cancellation",
  async (kind) => {
    const next = vi.fn<() => Promise<IteratorResult<Uint8Array>>>(() =>
      Promise.resolve({ done: false, value: new Uint8Array([1]) }),
    )
    const cancel = vi.fn<(reason?: unknown) => Promise<IteratorResult<Uint8Array>>>(() =>
      Promise.resolve({ done: true, value: undefined }),
    )
    const body =
      kind === "stream"
        ? new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                const chunk = await next()
                if (!chunk.done) controller.enqueue(chunk.value)
              },
              async cancel(reason) {
                await cancel(reason)
              },
            },
            { highWaterMark: 0 },
          )
        : { [Symbol.asyncIterator]: () => ({ next, return: cancel }) }
    const entered = Promise.withResolvers<void>()
    const read = Promise.withResolvers<void>()
    const paused = Promise.withResolvers<void>()
    const stop = Promise.withResolvers<void>()
    const reason = { stop: true }
    const fetch: Fetcher = async (request) => {
      entered.resolve()
      await read.promise
      if (!request.body) throw new Error("Expected an upload body")
      const upload = request.body.getReader()
      expect(await upload.read()).toMatchObject({ value: new Uint8Array([1]) })
      paused.resolve()
      await stop.promise
      await upload.cancel(reason)
      return sseResponse()
    }
    const reader = sseClient({ fetch })
      .stream("POST /events/{id}", {
        headers: { accept: "text/event-stream" },
        params: { id: 1 },
        body,
        reconnect: { maxAttempts: 1 },
      })
      .getReader()
    const pending = reader.read()
    await entered.promise
    expect(next).not.toHaveBeenCalled()
    read.resolve()
    await paused.promise
    await Promise.resolve()
    expect(next).toHaveBeenCalledOnce()
    stop.resolve()
    expect(await pending).toMatchObject({ value: { data: "hello" } })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel.mock.calls[0]?.[0]).toBe(reason)
    await reader.cancel()
  },
)

it.each([
  { reconnect: null, message: "SSE reconnect must be a boolean or an options object" },
  { reconnect: 1, message: "SSE reconnect must be a boolean or an options object" },
  {
    reconnect: { delay: -1, maxAttempts: 0 },
    message: "SSE reconnect delay must be a non-negative safe integer",
  },
  { reconnect: { maxAttempts: null }, message: "SSE maxAttempts must be a positive safe integer" },
])(
  "rejects malformed reconnect $reconnect before acquiring an upload",
  async ({ reconnect, message }) => {
    const acquire = vi.fn<() => AsyncIterator<Uint8Array>>(() => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }))
    const fetch = vi.fn<Fetcher>()
    const reader = sseClient({ fetch })
      .stream("POST /events/{id}", {
        headers: { accept: "text/event-stream" },
        params: { id: 1 },
        body: { [Symbol.asyncIterator]: acquire },
        reconnect: reconnect as unknown as false,
      })
      .getReader()
    await expect(reader.read()).rejects.toThrow(new TypeError(message))
    expect(acquire).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  },
)

it.each(["consumer", "signal"] as const)(
  "coordinates snapshot cleanup with %s cancellation",
  async (kind) => {
    const started = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    const cancel = vi.fn<(reason?: unknown) => Promise<void>>(() => cleanup.promise)
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull() {
          started.resolve()
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    // Supply a controllable Web body at the native Request boundary; retain native metadata.
    vi.spyOn(Request.prototype, "body", "get").mockReturnValue(source)
    const fetch = vi.fn<Fetcher>()
    const controller = new AbortController()
    const reason = { stopped: true }
    const failure = new Error("snapshot cleanup")
    const reader = sseClient({ fetch })
      .stream("POST /events/{id}", {
        headers: { accept: "text/event-stream" },
        params: { id: 1 },
        body: new Blob(["payload"]),
        reconnect: true,
        signal: controller.signal,
      })
      .getReader()
    const reading = reader.read().then(
      () => undefined,
      (error: unknown) => error,
    )
    await started.promise
    let cancellation: Promise<void> | undefined
    let settled = false
    if (kind === "consumer") {
      cancellation = reader.cancel(reason)
      void cancellation.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
    } else controller.abort(reason)
    try {
      expect(await reading).toBe(kind === "signal" ? reason : undefined)
      expect(cancel).toHaveBeenCalledOnce()
      expect(cancel.mock.calls[0]?.[0]).toBe(reason)
      expect(fetch).not.toHaveBeenCalled()
      expect(settled).toBe(false)
    } finally {
      cleanup.reject(failure)
      const cleanupError = await cancellation?.then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(cleanupError).toBe(kind === "consumer" ? failure : undefined)
    }
  },
)

it("does not send when aborted at snapshot EOF", async () => {
  const controller = new AbortController()
  const reason = { stopped: true }
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      pull(body) {
        body.close()
        queueMicrotask(() => controller.abort(reason))
      },
    },
    { highWaterMark: 0 },
  )
  vi.spyOn(Request.prototype, "body", "get").mockReturnValue(source)
  const fetch = vi.fn<Fetcher>()
  const reader = sseClient({ fetch })
    .stream("POST /events/{id}", {
      headers: { accept: "text/event-stream" },
      params: { id: 1 },
      body: new Blob(["payload"]),
      reconnect: true,
      signal: controller.signal,
    })
    .getReader()
  await expect(reader.read()).rejects.toBe(reason)
  expect(fetch).not.toHaveBeenCalled()
})
