import { describe, expect, it, vi } from "vitest"
import type { Fetcher } from "../../src/client"
import { createClient, StreamResponseError } from "../../src/client"
import { readJsonSequence } from "../../src/client/streams/parser-json-seq"

const encoder = new TextEncoder()
const media = "application/json-seq"

function api(response: Response) {
  const fetch = vi.fn<Fetcher>(() => Promise.resolve(response))
  const client = createClient<{
    "GET /records": { responses: { 200: { content: { "application/json-seq": unknown[] } } } }
  }>(
    {
      version: 7,
      endpoints: {
        "GET /records": {
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
  return { client, fetch }
}

async function parse(chunks: Uint8Array[]) {
  let index = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++])
        else controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const values: unknown[] = []
  for await (const value of readJsonSequence(body, new AbortController().signal)) values.push(value)
  return values
}

describe("JSON text sequences", () => {
  it("reads multiline JSON and all value types across every byte split", async () => {
    const values = [
      { text: '雪😀\\"\u001e', nested: [1, {}] },
      [2],
      "text",
      1.2e3,
      true,
      false,
      null,
    ]
    const encoded = encoder.encode(
      values.map((value) => `\x1e${JSON.stringify(value, null, 2)}\n`).join(""),
    )
    for (let i = 0; i <= encoded.length; i++) {
      // oxlint-disable-next-line no-await-in-loop -- every split must independently preserve records
      expect(await parse([encoded.slice(0, i), encoded.slice(i)])).toStrictEqual(values)
    }
    expect(await parse([...encoded].map((byte) => new Uint8Array([byte])))).toStrictEqual(values)
  })

  it.each([
    ["", []],
    ["unframed\n{}\n", []],
    ["\x1e\x1e\x1e", []],
    ['\x1e\n \t\r\n{"a":1}\n', [{ a: 1 }]],
    ['\x1e{}\x1e[]\x1e"ok"', [{}, [], "ok"]],
    ["\x1e123\x1etrue\x1efalse\x1enull", []],
    ["\x1e123 \x1etrue\t\x1efalse\r\x1enull\n", [123, true, false, null]],
    ['\x1e{"bad":\n\x1e{}\n\x1e"cut\x1e[]\n', [{}, []]],
    ["\x1eNaN\n\x1etruefalse\n\x1e1\n2\n\x1e{}\n", [1, {}]],
    ['\x1e\uFEFF{}\n\x1e{"ok":true}\n', [{ ok: true }]],
    ['\x1e{"cut":', []],
  ])("recovers or finishes input %j", async (text, expected) => {
    expect(await parse([encoder.encode(text)])).toStrictEqual(expected)
  })

  it("drops malformed UTF-8 and resumes decoding at the next RS", async () => {
    expect(await parse([new Uint8Array([30, 34, 0xc3, 0x28, 34, 10, 30, 49, 10])])).toStrictEqual([
      1,
    ])
    expect(await parse([new Uint8Array([30, 34, 0xc3])])).toStrictEqual([])
  })

  it("delivers a live record on demand and propagates cancellation without reading ahead", async () => {
    const cancel = vi.fn<(reason?: unknown) => void>()
    const pull = vi.fn<(controller: ReadableStreamDefaultController<Uint8Array>) => void>(
      (controller) => {
        controller.enqueue(encoder.encode('\x1e{\n"id":1\n}\n'))
      },
    )
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
    const { client, fetch } = api(
      new Response(body, { headers: { "content-type": "Application/JSON-SEQ; charset=utf-8" } }),
    )
    const stream = client.stream("GET /records")
    const reader = stream.getReader()
    expect(stream).toBeInstanceOf(ReadableStream)
    expect(fetch).not.toHaveBeenCalled()
    expect(await reader.read()).toMatchObject({ value: { id: 1 } })
    expect(pull).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0].headers.get("accept")).toBe(media)
    const reason = { done: true }
    await reader.cancel(reason)
    expect(cancel.mock.calls[0]?.[0]).toBe(reason)
    expect(body.locked).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("preserves abort and transport errors while discarding pending records", async () => {
    const abort = new AbortController()
    const cancel = vi.fn<(reason?: unknown) => void>()
    const abortBody = new ReadableStream<Uint8Array>({ cancel })
    const { client } = api(new Response(abortBody, { headers: { "content-type": media } }))
    const reader = client.stream("GET /records", { signal: abort.signal }).getReader()
    const pending = reader.read()
    await vi.waitFor(() => expect(abortBody.locked).toBe(true))
    const reason = new Error("stop")
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(cancel.mock.calls[0]?.[0]).toBe(reason))

    const failure = new Error("network")
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
    })
    const other = api(new Response(body, { headers: { "content-type": media } }))
    const next = other.client.stream("GET /records").getReader().read()
    source?.enqueue(encoder.encode('\x1e{"partial":'))
    source?.error(failure)
    await expect(next).rejects.toBe(failure)
    expect(other.fetch).toHaveBeenCalledOnce()
  })

  it("validates response media and rejects retry before transport", async () => {
    const { client, fetch } = api(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    )
    await expect(client.stream("GET /records").getReader().read()).rejects.toBeInstanceOf(
      StreamResponseError,
    )
    const unsafe = client.stream as (key: string, options: object) => ReadableStream<unknown>
    await expect(unsafe("GET /records", { retry: {} }).getReader().read()).rejects.toThrow(
      "requires a single SSE",
    )
    expect(fetch).toHaveBeenCalledOnce()
  })
})
