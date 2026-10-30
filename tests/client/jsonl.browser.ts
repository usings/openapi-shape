import { describe, expect, it, vi } from "vitest"
import type { ClientOptions, Fetcher, StreamMessage } from "../../src/client"
import { createClient, StreamParseError, StreamResponseError } from "../../src/client"
import { readJsonLines } from "../../src/client/streams/parser-jsonl"

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const item of items) values.push(item)
  return values
}

function body(chunks: Uint8Array[], failure?: Error): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++])
        else if (failure) controller.error(failure)
        else controller.close()
      },
    },
    { highWaterMark: 0 },
  )
}

const encoder = new TextEncoder()

function api(options: ClientOptions = {}) {
  return createClient<{
    "GET /records": {
      responses: { 200: { content: { "application/x-ndjson": Array<{ id: number } | null> } } }
    }
    "GET /jsonl": { responses: { 200: { content: { "application/jsonl": unknown[] } } } }
    "GET /mixed": {
      responses: {
        200: {
          content: { "text/event-stream": StreamMessage[]; "application/x-ndjson": number[] }
        }
      }
    }
  }>(
    {
      version: 7,
      endpoints: {
        "GET /records": {
          responses: {
            "200": {
              content: { "application/x-ndjson": {} },
            },
          },
        },
        "GET /jsonl": {
          responses: {
            "200": {
              content: { "application/jsonl": {} },
            },
          },
        },
        "GET /mixed": {
          responses: {
            "200": {
              content: Object.fromEntries(
                ["text/event-stream", "application/x-ndjson"].map((media) => [media, {}]),
              ),
            },
          },
        },
      },
    },
    { baseURL: "https://example.test", ...options },
  )
}

const jsonResponse = (text: string, media = "application/x-ndjson") =>
  new Response(text, { headers: { "content-type": media } })

describe("JSON line parser", () => {
  it("preserves all JSON values for every byte split, including CRLF and a final unterminated record", async () => {
    const encoded = encoder.encode('{"text":"雪😀"}\r\n[1,[2]]\n"value"\ntrue\nfalse\nnull\n12.5')
    const expected = [{ text: "雪😀" }, [1, [2]], "value", true, false, null, 12.5]
    const partitions = Array.from({ length: encoded.length + 1 }, (_, index) => [
      encoded.slice(0, index),
      encoded.slice(index),
    ])
    partitions.push([...encoded].map((byte) => new Uint8Array([byte])))
    for (const chunks of partitions) {
      // oxlint-disable-next-line no-await-in-loop -- each partition independently drives the parser
      const actual = await collect(readJsonLines(body(chunks), new AbortController().signal))
      expect(actual).toStrictEqual(expected)
    }
  })

  it.each([
    "\n",
    " \n",
    "\r\n",
    "{bad}\n",
    "\uFEFF{}\n",
    "1\r2\n",
    '"unescaped\nnewline"\n',
    '{"cut":',
  ])("rejects invalid record %j with line and cause", async (text) => {
    const failure = await collect(
      readJsonLines(body([encoder.encode(text)]), new AbortController().signal),
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StreamParseError)
    expect(failure).toMatchObject({ line: 1, cause: expect.any(Error) })
    const record = text.trim()
    expect(record !== "" && (failure as Error).message.includes(record)).toBe(false)
  })

  it("closes an empty stream and accepts one trailing line delimiter", async () => {
    expect(await collect(readJsonLines(body([]), new AbortController().signal))).toStrictEqual([])
    expect(
      await collect(readJsonLines(body([encoder.encode("1\n")]), new AbortController().signal)),
    ).toStrictEqual([1])
  })

  it("does not parse or decode the next record in the same chunk before demand", async () => {
    const invalidUtf8 = new Uint8Array([
      ...encoder.encode('1\n"'),
      0xc3,
      0x28,
      ...encoder.encode('"\n'),
    ])
    const iterator = readJsonLines(body([invalidUtf8]), new AbortController().signal)
    expect(await iterator.next()).toStrictEqual({ value: 1, done: false })
    await expect(iterator.next()).rejects.toMatchObject({ name: "StreamParseError", line: 2 })
  })

  it("reports later malformed JSON on its actual line without exposing the payload", async () => {
    const iterator = readJsonLines(
      body([encoder.encode('1\n{"secret":bad}\n')]),
      new AbortController().signal,
    )
    expect(await iterator.next()).toMatchObject({ value: 1 })
    const failure = await iterator.next().catch((error: unknown) => error)
    expect(failure).toMatchObject({ line: 2 })
    expect((failure as Error).message).not.toContain("secret")
  })

  it("flushes and rejects a truncated UTF-8 character at EOF", async () => {
    const iterator = readJsonLines(
      body([new Uint8Array([0x22, 0xc3])]),
      new AbortController().signal,
    )
    await expect(iterator.next()).rejects.toMatchObject({ name: "StreamParseError", line: 1 })
  })

  it("never publishes a final partial record after a response read error", async () => {
    const failure = new Error("connection reset")
    const iterator = readJsonLines(
      body([encoder.encode("1\n42")], failure),
      new AbortController().signal,
    )
    expect(await iterator.next()).toStrictEqual({ value: 1, done: false })
    await expect(iterator.next()).rejects.toBe(failure)
  })
})

describe("JSON line streams", () => {
  it.each(["application/x-ndjson", "application/jsonl"])(
    "reads %s until EOF without another request",
    async (media) => {
      const fetch = vi.fn<Fetcher>().mockResolvedValue(jsonResponse('{"id":1}\nnull', media))
      const client = api({ fetch })
      const stream =
        media === "application/jsonl" ? client.stream("GET /jsonl") : client.stream("GET /records")
      expect(fetch).not.toHaveBeenCalled()
      expect(await collect(stream)).toStrictEqual([{ id: 1 }, null])
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0][0].headers.get("accept")).toBe(media)
    },
  )

  it("negotiates lists and defaults while rejecting automatic JSON retry before transport", async () => {
    const fetch = vi.fn<Fetcher>().mockImplementation(() => Promise.resolve(jsonResponse("1\n2\n")))
    const client = api({ fetch })
    expect(
      await collect(client.stream("GET /mixed", { headers: { accept: "application/x-ndjson" } })),
    ).toStrictEqual([1, 2])
    expect(await collect(client.stream("GET /mixed"))).toStrictEqual([1, 2])
    expect(fetch.mock.calls[1][0].headers.get("accept")).toContain("application/x-ndjson")
    expect(
      await collect(
        client.stream("GET /mixed", {
          headers: new Headers({ accept: "text/event-stream;q=0.5, application/x-ndjson" }),
        }),
      ),
    ).toStrictEqual([1, 2])
    expect(await collect(client.stream("GET /records", { retry: false }))).toStrictEqual([1, 2])
    await expect(
      collect(
        (client.stream as (key: string, options: object) => ReadableStream<unknown>)(
          "GET /records",
          { retry: {} },
        ),
      ),
    ).rejects.toThrow("requires a single SSE")
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it("uses the selected representation for Accept and validates the actual response", async () => {
    const fetch = vi.fn<Fetcher>().mockResolvedValue(jsonResponse("{}", "application/json"))
    await expect(
      collect(
        api({ fetch }).stream("GET /records", { headers: { Accept: "application/x-ndjson" } }),
      ),
    ).rejects.toBeInstanceOf(StreamResponseError)
    expect(fetch.mock.calls[0][0].headers.get("accept")).toBe("application/x-ndjson")
  })

  it.each([408, 429, 503])("does not retry HTTP %s", async (status) => {
    const fetch = vi.fn<Fetcher>().mockResolvedValue(new Response(null, { status }))
    await expect(collect(api({ fetch }).stream("GET /records"))).rejects.toMatchObject({
      response: { status },
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("does not retry a network or parser failure", async () => {
    const failure = new Error("offline")
    const fetch = vi.fn<Fetcher>().mockRejectedValue(failure)
    await expect(collect(api({ fetch }).stream("GET /records"))).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledOnce()
    fetch.mockResolvedValue(jsonResponse("invalid\n"))
    await expect(collect(api({ fetch }).stream("GET /records"))).rejects.toBeInstanceOf(
      StreamParseError,
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("accepts 204 without a response body", async () => {
    expect(
      await collect(
        api({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }).stream(
          "GET /records",
        ),
      ),
    ).toStrictEqual([])
  })

  it("cancels the underlying reader on early iteration exit", async () => {
    const cancel = vi.fn<() => void>()
    const client = api({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode("1\n2\n"))
              },
              cancel,
            }),
            { headers: { "content-type": "application/jsonl" } },
          ),
        ),
    })
    const values: unknown[] = []
    for await (const value of client.stream("GET /jsonl")) {
      values.push(value)
      break
    }
    expect(values).toStrictEqual([1])
    expect(cancel).toHaveBeenCalledOnce()
  })
})
