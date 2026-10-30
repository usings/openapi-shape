import { describe, expect, it, vi } from "vitest"
import type { Fetcher, StreamMessage } from "../../src/client"
import { createClient } from "../../src/client"

const encoder = new TextEncoder()
const formats = [
  {
    media: "text/event-stream",
    record: "data:雪😀\n\n",
    unfinished: "data:雪😀!",
    limit: 12,
    value: { data: "雪😀", event: "message", id: "" },
  },
  {
    media: "application/jsonl",
    record: '"雪😀"\n',
    unfinished: '"雪😀!!',
    limit: 9,
    value: "雪😀",
  },
  {
    media: "application/json-seq",
    record: '\x1e"雪😀"\n',
    unfinished: '\x1e"雪😀!!',
    limit: 9,
    value: "雪😀",
  },
] as const
type Media = (typeof formats)[number]["media"]

function fixture(
  media: Media,
  chunks: Uint8Array[],
  options: { close?: boolean; cleanup?: Promise<void> } = {},
) {
  let index = 0
  const cancel = vi.fn<() => Promise<void> | undefined>(() => options.cleanup)
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++])
        else if (options.close !== false) controller.close()
      },
      cancel,
    },
    { highWaterMark: 0 },
  )
  const fetch = vi.fn<Fetcher>(() =>
    Promise.resolve(new Response(body, { headers: { "content-type": media } })),
  )
  const client = createClient<{
    "GET /data": {
      responses: {
        200: {
          content: {
            "text/event-stream": StreamMessage[]
            "application/jsonl": unknown[]
            "application/json-seq": unknown[]
          }
        }
      }
    }
  }>(
    {
      version: 7,
      endpoints: {
        "GET /data": {
          responses: {
            "200": {
              content: { [media]: {} },
            },
          },
        },
      },
    },
    { baseURL: "https://example.test", fetch },
  )
  const open = (maxMessageBytes?: number): ReadableStream<unknown> =>
    media === "text/event-stream"
      ? client.stream("GET /data", { retry: false, maxMessageBytes, headers: { accept: media } })
      : media === "application/jsonl"
        ? client.stream("GET /data", { maxMessageBytes, headers: { accept: media } })
        : client.stream("GET /data", { maxMessageBytes, headers: { accept: media } })
  return { client, open, body, fetch, cancel }
}

async function collect(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of stream) values.push(value)
  return values
}

describe("per-message stream byte limits", () => {
  it.each(formats)(
    "limits each $media record rather than a chunk or connection",
    async (format) => {
      const { open, fetch } = fixture(format.media, [encoder.encode(format.record.repeat(64))])
      expect(await collect(open(format.limit))).toStrictEqual(
        Array.from({ length: 64 }, () => format.value),
      )
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  it.each(formats)("accepts an exact UTF-8 limit across byte splits for $media", async (format) => {
    const chunks = [...encoder.encode(format.record)].map((byte) => new Uint8Array([byte]))
    expect(await collect(fixture(format.media, chunks).open(format.limit))).toStrictEqual([
      format.value,
    ])
  })

  it.each(formats)(
    "stops an unfinished oversized $media record without waiting for EOF",
    async (format) => {
      const chunks = [...encoder.encode(format.unfinished)].map((byte) => new Uint8Array([byte]))
      const { open, body, fetch, cancel } = fixture(format.media, chunks, { close: false })
      const reader = open(format.limit).getReader()
      let failure: unknown
      const pending = reader.read().catch((error: unknown) => {
        failure = error
      })
      try {
        await vi.waitFor(() => expect(failure).toMatchObject({ code: "MESSAGE_TOO_LARGE" }))
        expect(failure).toMatchObject({
          code: "MESSAGE_TOO_LARGE",
          details: { maxMessageBytes: format.limit, receivedBytes: format.limit + 1 },
        })
        expect((failure as Error).message).not.toContain("雪")
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(body.locked).toBe(false))
        expect(fetch).toHaveBeenCalledOnce()
      } finally {
        await reader.cancel().catch((error: unknown) => error)
        reader.releaseLock()
        await pending
      }
    },
  )

  it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "8"])(
    "rejects invalid maxMessageBytes %j before transport",
    async (value) => {
      const { open, fetch } = fixture("application/jsonl", [])
      const stream = open(value as number)
      expect(fetch).not.toHaveBeenCalled()
      await expect(stream.getReader().read()).rejects.toBeInstanceOf(TypeError)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([1, Number.MAX_SAFE_INTEGER])("accepts positive safe integer %s", async (limit) => {
    const { open } = fixture("application/jsonl", [encoder.encode("0\n")])
    expect(await collect(open(limit))).toStrictEqual([0])
  })

  it("discards completed SSE heartbeats without accumulating them into an event", async () => {
    const text = `${": ping\r\n".repeat(64)}data:x\n${":\n".repeat(64)}\n`
    const chunks = [...encoder.encode(text)].map((byte) => new Uint8Array([byte]))
    const { open } = fixture("text/event-stream", chunks)
    expect(await collect(open(7))).toStrictEqual([{ data: "x", event: "message", id: "" }])
  })

  it.each(["data:a\ndata:b\n\n", "id:abc\ndata:x\n\n"])(
    "bounds all SSE field lines in one message: %j",
    async (text) => {
      const { open } = fixture("text/event-stream", [encoder.encode(text)])
      await expect(collect(open(11))).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" })
    },
  )

  it.each([":0123456789", "id:0123456789", "event:0123456789"])(
    "also bounds unfinished SSE metadata and comment lines: %j",
    async (text) => {
      const { open } = fixture("text/event-stream", [encoder.encode(text)])
      await expect(collect(open(8))).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" })
    },
  )

  it("does not retry SSE messages that exceed the limit", async () => {
    const { client, fetch } = fixture("text/event-stream", [encoder.encode("data:too large")])
    const stream = client.stream("GET /data", {
      maxMessageBytes: 8,
      retry: { delay: 0, maxRetries: 2 },
      headers: { accept: "text/event-stream" },
    })
    await expect(collect(stream)).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("resets the JSON sequence budget after a malformed record", async () => {
    const { open } = fixture("application/json-seq", [encoder.encode("\x1e{\x1e1\n")])
    expect(await collect(open(1))).toStrictEqual([1])
  })

  it("reports a limit failure promptly even when body cleanup stalls", async () => {
    const cleanup = Promise.withResolvers<void>()
    const { open, body } = fixture("application/jsonl", [encoder.encode('"too large')], {
      close: false,
      cleanup: cleanup.promise,
    })
    const reader = open(3).getReader()
    let failure: unknown
    const pending = reader.read().catch((error: unknown) => {
      failure = error
    })
    try {
      await vi.waitFor(() => expect(failure).toMatchObject({ code: "MESSAGE_TOO_LARGE" }))
    } finally {
      cleanup.resolve()
      await pending
      reader.releaseLock()
    }
    await vi.waitFor(() => expect(body.locked).toBe(false))
  })
})
