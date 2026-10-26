import type { ServerResponse } from "node:http"
import { expect, it } from "vitest"
import { createClient } from "../src/client"
import type { ClientOptions, StreamMessage } from "../src/client"
import { withServer } from "./helpers/http"

function events(baseURL: string, options: ClientOptions = {}) {
  return createClient<{
    "POST /events": {
      body: { "multipart/form-data": { topic: string } }
      responses: { 200: { content: { "text/event-stream": StreamMessage[] } } }
    }
  }>(
    {
      version: 6,
      endpoints: {
        "POST /events": { stream: ["text/event-stream"], contentType: "multipart/form-data" },
      },
    },
    { baseURL, ...options },
  )
}

it("reconnects native Fetch after EOF with identical multipart bytes and a fresh middleware pass", async () => {
  const received: Array<{
    body: string
    contentType: string | undefined
    cursor: string | undefined
    token: string | undefined
  }> = []
  let token = 0
  await withServer(
    (request, response) => {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        received.push({
          body,
          contentType: request.headers["content-type"],
          cursor: request.headers["last-event-id"] as string | undefined,
          token: request.headers.authorization,
        })
        if (received.length === 1) {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.end("id: 7\ndata: one\n\n")
        } else {
          response.writeHead(204)
          response.end()
        }
      })
    },
    async (url) => {
      const form = new FormData()
      form.set("topic", "orders")
      const api = events(url, {
        middleware: [
          (request, next) => {
            const copy = new Request(request)
            copy.headers.set("authorization", `token-${++token}`)
            return next(copy)
          },
        ],
      })
      const items: StreamMessage[] = []
      for await (const item of api.stream("POST /events", { body: form, retry: { delay: 0 } }))
        items.push(item)
      expect(items).toStrictEqual([{ data: "one", event: "message", id: "7" }])
    },
  )
  expect(received).toHaveLength(2)
  expect(received[0].contentType).toMatch(/^multipart\/form-data; boundary=/)
  expect(received[1]).toStrictEqual({ ...received[0], cursor: "7", token: "token-2" })
  expect(received[0].token).toBe("token-1")
})

it("recovers from a socket reset without advancing an incomplete cursor", async () => {
  let connection = 0
  let firstResponse: ServerResponse | undefined
  const cursors: Array<string | undefined> = []
  await withServer(
    (request, response) => {
      cursors.push(request.headers["last-event-id"] as string | undefined)
      response.writeHead(200, { "content-type": "text/event-stream" })
      if (++connection === 1) {
        firstResponse = response
        response.write("id: complete\ndata: first\n\nid: incomplete\ndata: lost")
      } else response.end("data: second\n\n")
    },
    async (url) => {
      const reader = events(url)
        .stream("POST /events", { body: { topic: "orders" }, retry: { delay: 0, maxRetries: 1 } })
        .getReader()
      expect(await reader.read()).toMatchObject({ value: { data: "first", id: "complete" } })
      const next = reader.read()
      firstResponse?.destroy()
      expect(await next).toMatchObject({ value: { data: "second", id: "complete" } })
      expect(await reader.read()).toMatchObject({ done: true })
    },
  )
  expect(cursors).toStrictEqual([undefined, "complete"])
})

it("reader cancellation closes a live native HTTP response without reconnecting", async () => {
  let requests = 0
  const closed = Promise.withResolvers<void>()
  await withServer(
    (_request, response) => {
      requests++
      response.on("close", () => closed.resolve())
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("data: live\n\n")
    },
    async (url) => {
      const reader = events(url)
        .stream("POST /events", { body: { topic: "orders" } })
        .getReader()
      await reader.read()
      await reader.cancel("finished")
      await closed.promise
      expect(await reader.read()).toMatchObject({ done: true })
    },
  )
  expect(requests).toBe(1)
})

it("reads native JSONL HTTP chunks and the final record without a newline", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/jsonl; charset=utf-8" })
      const encoded = new TextEncoder().encode('{"text":"雪😀"}\nnull')
      response.write(encoded.subarray(0, 11))
      response.end(encoded.subarray(11))
    },
    async (url) => {
      const api = createClient<{
        "GET /records": { responses: { 200: { content: { "application/jsonl": unknown[] } } } }
      }>(
        { version: 6, endpoints: { "GET /records": { stream: ["application/jsonl"] } } },
        { baseURL: url },
      )
      const items: unknown[] = []
      for await (const item of api.stream("GET /records")) items.push(item)
      expect(items).toStrictEqual([{ text: "雪😀" }, null])
    },
  )
})

it("delivers a native JSON sequence record before EOF and cancels its live response", async () => {
  const closed = Promise.withResolvers<void>()
  let requests = 0
  await withServer(
    (request, response) => {
      requests++
      expect(request.headers.accept).toBe("application/json-seq")
      response.on("close", () => closed.resolve())
      response.writeHead(200, { "content-type": "application/json-seq" })
      response.write('\x1e{\n"text":"雪😀"\n}\n')
    },
    async (url) => {
      const api = createClient<{
        "GET /records": { responses: { 200: { content: { "application/json-seq": unknown[] } } } }
      }>(
        { version: 6, endpoints: { "GET /records": { stream: ["application/json-seq"] } } },
        { baseURL: url },
      )
      const reader = api.stream("GET /records").getReader()
      expect(await reader.read()).toMatchObject({ value: { text: "雪😀" } })
      await reader.cancel("finished")
      await closed.promise
      expect(await reader.read()).toMatchObject({ done: true })
    },
  )
  expect(requests).toBe(1)
})
