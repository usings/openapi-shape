import { expect, it, vi } from "vitest"
import type { Middleware } from "../../src/client"
import { snapshotRequestBody } from "../../src/client/streams/body-snapshot"

it.each(["resolve", "reject", "pending"])(
  "cancels a snapshot promptly when cleanup is %s",
  async (cleanup) => {
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const cancel = vi.fn<(reason?: unknown) => void | Promise<void>>(() => {
      if (cleanup === "reject") return Promise.reject(new Error("cleanup"))
      if (cleanup === "pending")
        return new Promise<void>(() => {
          /* Hold cleanup open without a timer. */
        })
    })
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve()
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    const reason = { stopped: true }
    const pending = snapshotRequestBody(body, controller.signal, {})
    const outcome = pending.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    )
    await started.promise
    controller.abort(reason)
    const result = await outcome
    expect(result.error).toBe(reason)
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel.mock.calls[0]?.[0]).toBe(reason)
  },
)

it("releases a completed snapshot and preserves its bytes", async () => {
  const cancel = vi.fn<(reason?: unknown) => void>()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 255]))
      controller.enqueue(new Uint8Array([1]))
      controller.close()
    },
    cancel,
  })
  const owner = {}
  expect(await snapshotRequestBody(body, new AbortController().signal, owner)).toStrictEqual(
    new Uint8Array([0, 255, 1]),
  )
  expect(body.locked).toBe(false)
  expect(cancel).not.toHaveBeenCalled()
})

it("cancels an already aborted snapshot without reading it", async () => {
  const controller = new AbortController()
  const reason = new Error("stop")
  controller.abort(reason)
  const pull = vi.fn<() => void>()
  const cancel = vi.fn<(reason?: unknown) => void>()
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
  await expect(snapshotRequestBody(body, controller.signal, {})).rejects.toBe(reason)
  expect(pull).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
  expect(cancel.mock.calls[0]?.[0]).toBe(reason)
})

it("replays identical multipart bytes and boundary through fresh middleware", async () => {
  const { createClient } = await import("../../src/client")
  const sent: Array<{ bytes: number[]; contentType: string | null }> = []
  const middleware = vi.fn<Middleware>((request, next) => next(request))
  const client = createClient<{
    "POST /events": {
      body: { "multipart/form-data": { file: Blob } }
      responses: { 200: { content: { "text/event-stream": unknown[] } } }
    }
  }>(
    {
      version: 7,
      endpoints: {
        "POST /events": {
          requestBody: { required: true, content: { "multipart/form-data": {} } },
          responses: { "200": { content: { "text/event-stream": {} } } },
        },
      },
    },
    {
      baseURL: "https://example.test",
      middleware: [middleware],
      fetch: async (request) => {
        sent.push({
          bytes: [...new Uint8Array(await request.arrayBuffer())],
          contentType: request.headers.get("content-type"),
        })
        return new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } })
      },
    },
  )
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array([0, 255, 13, 10])]), "payload.bin")
  const values = []
  for await (const value of client.stream("POST /events", {
    body: form,
    reconnect: { delay: 0, maxAttempts: 3 },
  }))
    values.push(value)
  expect(values).toHaveLength(3)
  expect(sent).toHaveLength(3)
  expect(sent[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/)
  expect(sent[0]?.bytes).toStrictEqual(expect.arrayContaining([255]))
  expect(sent[1]).toStrictEqual(sent[0])
  expect(sent[2]).toStrictEqual(sent[0])
  expect(middleware).toHaveBeenCalledTimes(3)
})
