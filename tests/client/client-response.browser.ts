import { describe, expect, it, vi } from "vitest"
import { createClient } from "../../src/client"
import { contract } from "../fixtures/output/client-api"
import { recorder } from "../support/client"
import type { ResultOperation } from "../support/contract"

/** What `result` reads from a response with this body, content type, and status. */
async function decoded(body: BodyInit | null, type?: string, status = 200): Promise<unknown> {
  const headers = type === undefined ? undefined : { "content-type": type }
  const { client } = recorder<{
    "GET /x": ResultOperation
  }>(
    {
      version: 7,
      endpoints: { "GET /x": { responses: { default: { content: { "*/*": {} } } } } },
    },
    {},
    () => new Response(body, { status, headers }),
  )
  const { data, error } = await client.result("GET /x")
  return status < 300 ? data : error
}

describe("responses", () => {
  it("hands the request to the fetch option, called unbound, and resolves to its response", async () => {
    const answer = new Response("{}", { status: 404 })
    const client = createClient(contract, {
      baseURL: "https://api.test",
      // A browser's fetch refuses to be called on another object.
      fetch(this: unknown, request) {
        expect(this).toBeUndefined()
        expect(request.url).toBe("https://api.test/pets/1")
        return Promise.resolve(answer)
      },
    })
    expect(await client.fetch("GET /pets/{id}", { params: { id: 1 } })).toBe(answer)
  })

  it.each([
    ['{"id":1}', "application/json; charset=utf-8", { id: 1 }],
    ['{"id":1}', "application/problem+json", { id: 1 }],
    ["hello", "text/plain", "hello"],
    // An empty text body is still text.
    ["", "text/plain", ""],
    [null, undefined, new Blob([])],
  ])("reads a body by its content type (%#)", async (body, type, expected) => {
    expect(await decoded(body, type)).toStrictEqual(expected)
    // A failure's error is never undefined: without a body, it is null.
    expect(await decoded(body, type, 500)).toStrictEqual(expected ?? null)
  })

  it("reads no content as undefined, and other content as a Blob", async () => {
    expect(await decoded(null, "application/json", 204)).toBeUndefined()
    expect(await decoded(null, "application/json", 205)).toBeUndefined()
    expect(await decoded(null, "application/json", 304)).toBeNull()
    // A body where none can be is still consumed, so that the connection is free.
    const { client } = recorder<{ "HEAD /x": ResultOperation }>(
      {
        version: 7,
        endpoints: { "HEAD /x": { responses: { default: { content: { "*/*": {} } } } } },
      },
      {},
      () => new Response("x", { status: 200, headers: { "content-type": "application/json" } }),
    )
    const { data, response } = await client.result("HEAD /x")
    expect(data).toBeUndefined()
    expect(response.bodyUsed).toBe(true)
    expect(await decoded("abc", "image/png")).toBeInstanceOf(Blob)
    expect(await decoded(new Blob(["abc"]))).toBeInstanceOf(Blob)
    // Event streams and JSON sequences are not parsed: `fetch` streams them.
    await expect(decoded("data: x\n\n", "text/event-stream")).rejects.toThrow("Response media")
    await expect(decoded('{"a":1}\n', "application/jsonl")).rejects.toThrow("Response media")
  })

  it("gives the data of a success and the error of a failure, with the status, its body read", async () => {
    let status = 200
    const { client } = recorder(
      contract,
      {},
      () =>
        new Response(status === 200 ? '{"id":1,"name":"Rex"}' : '{"message":"nope"}', {
          status,
          headers: { "content-type": "application/json" },
        }),
    )
    const found = await client.result("GET /pets/{id}", { params: { id: 1 } })
    expect(found).toMatchObject({ data: { id: 1, name: "Rex" }, error: undefined, status: 200 })
    status = 404
    const missing = await client.result("GET /pets/{id}", { params: { id: 1 } })
    expect(missing).toMatchObject({ data: undefined, error: { message: "nope" }, status: 404 })
    // The body is read, so the connection is free again.
    expect(missing.response.bodyUsed).toBe(true)
  })
})

describe("native response decoding", () => {
  it.each([
    ["middleware", "application/json"],
    ["transport", "text/plain"],
    ["transport", "image/png"],
    ["middleware", undefined],
  ])(
    "cancels a %s response of type %s while reading, even when cleanup stalls",
    async (source, type) => {
      const reading = Promise.withResolvers<void>()
      const canceled = Promise.withResolvers<unknown>()
      const cleanup = Promise.withResolvers<void>()
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            start(value) {
              controller = value
            },
            pull() {
              reading.resolve()
            },
            cancel(reason) {
              canceled.resolve(reason)
              return cleanup.promise
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: type === undefined ? undefined : { "content-type": type } },
      )
      const { client } = recorder(
        {
          ...contract,
          endpoints: {
            ...contract.endpoints,
            "GET /pets": { responses: { "200": { content: { "*/*": {} } } } },
          },
        },
        source === "middleware" ? { middleware: [() => Promise.resolve(response)] } : {},
        () => response,
      )
      const stop = new AbortController()
      const reason = { stopped: true }
      let failure: unknown
      const result = client.result("GET /pets", { signal: stop.signal }).catch((error: unknown) => {
        failure = error
      })
      try {
        await reading.promise
        stop.abort(reason)
        await vi.waitFor(() => expect(failure).toBe(reason))
        expect(await canceled.promise).toBe(reason)
        expect(response.bodyUsed).toBe(true)
      } finally {
        cleanup.resolve()
        controller?.error(new Error("Test cleanup"))
        await result
      }
      await vi.waitFor(() => expect(response.body?.locked).toBe(false))
    },
  )

  it("allows abort to interrupt stalled cleanup of a bodyless response", async () => {
    const canceled = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    const { client } = recorder<{ "HEAD /x": ResultOperation }>(
      {
        version: 7,
        endpoints: { "HEAD /x": { responses: { default: { content: { "*/*": {} } } } } },
      },
      {},
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled.resolve()
              return cleanup.promise
            },
          }),
        ),
    )
    const stop = new AbortController()
    const reason = new Error("Stop reading")
    const result = client.result("HEAD /x", { signal: stop.signal })
    try {
      await canceled.promise
      stop.abort(reason)
      await expect(result).rejects.toBe(reason)
    } finally {
      cleanup.resolve()
    }
  })

  it.each(["consumed", "locked"])("rejects an already %s response body", async (state) => {
    const response = Response.json([])
    const reader = state === "locked" ? response.body?.getReader() : undefined
    if (state === "consumed") await response.json()
    const { client } = recorder(contract, {}, () => response)
    try {
      await expect(client.result("GET /pets")).rejects.toBeInstanceOf(TypeError)
    } finally {
      reader?.releaseLock()
      if (!response.bodyUsed) await response.body?.cancel()
    }
  })

  it.each(["", " \n", "{bad}"])("rejects invalid JSON %j", async (body) => {
    await expect(decoded(body, "application/json")).rejects.toBeInstanceOf(SyntaxError)
  })

  it.each([
    ["text/plain, application/json", { ok: true }],
    ['text/plain; note="a,b", application/json', { ok: true }],
    ["application/json, cannot-parse, */*", { ok: true }],
    ["application/json, text/plain", '{"ok":true}'],
  ])("decodes the last valid MIME type from %s", async (header, expected) => {
    expect(await decoded('{"ok":true}', header)).toStrictEqual(expected)
  })

  it("keeps bytes when no valid MIME type is supplied", async () => {
    const value = await decoded("payload", "cannot-parse")
    expect(value).toBeInstanceOf(Blob)
    expect(await (value as Blob).text()).toBe("payload")
  })
})
