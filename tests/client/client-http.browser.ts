import { expect, inject, it } from "vitest"
import type { ClientOptions, StreamMessage } from "../../src/client"
import { createClient } from "../../src/client"

interface Api {
  "GET /data": { responses: { 200: { content: { "application/json": { ok: true } } } } }
  "GET /empty": Api["GET /data"]
  "GET /redirect": Api["GET /data"]
  "GET /allowed": Api["GET /data"]
  "GET /blocked": Api["GET /data"]
  "GET /events": {
    query?: { id: string }
    responses: { 200: { content: { "text/event-stream": StreamMessage[] } } }
  }
  "POST /echo": {
    body: { "application/x-www-form-urlencoded": { foo: string } }
    responses: { 200: { content: { "application/json": { body: string; type: string } } } }
  }
}

function client(options: ClientOptions = {}) {
  return createClient<Api>(
    {
      version: 7,
      endpoints: {
        "GET /data": { responses: { default: { content: { "*/*": {} } } } },
        "GET /empty": { responses: { default: { content: { "*/*": {} } } } },
        "GET /redirect": { responses: { default: { content: { "*/*": {} } } } },
        "GET /allowed": { responses: { default: { content: { "*/*": {} } } } },
        "GET /blocked": { responses: { default: { content: { "*/*": {} } } } },
        "GET /events": {
          responses: {
            "200": {
              content: { "text/event-stream": {} },
            },
          },
        },
        "POST /echo": {
          requestBody: {
            required: false,
            content: { "application/x-www-form-urlencoded": {}, "multipart/form-data": {} },
          },
          responses: { default: { content: { "*/*": {} } } },
        },
      },
    },
    { baseURL: inject("browserBaseURL"), ...options },
  )
}

it("preserves native redirect metadata and the unread Response", async () => {
  const response = await client().fetch("GET /redirect")
  expect(response).toBeInstanceOf(Response)
  expect(response.redirected).toBe(true)
  expect(new URL(response.url).pathname).toBe("/data")
  expect(response.bodyUsed).toBe(false)
  expect(await response.json()).toStrictEqual({ ok: true })
})

it("preserves native empty JSON rejection", async () => {
  await expect(client().result("GET /empty")).rejects.toMatchObject({ name: "SyntaxError" })
})

it("allows native CORS responses and propagates CORS rejection", async () => {
  const api = client()
  const allowed = await api.result("GET /allowed")
  expect(allowed.data).toStrictEqual({ ok: true })
  await expect(api.fetch("GET /blocked")).rejects.toBeInstanceOf(TypeError)
})

it("hands off opaque no-cors responses without consuming them", async () => {
  const response = await client().fetch("GET /blocked", { mode: "no-cors" })
  expect(response.type).toBe("opaque")
  // Filtered responses are a browser runtime fact outside declared OpenAPI status types.
  expect(Number(response.status)).toBe(0)
  expect(response.body).toBeNull()
  expect(response.bodyUsed).toBe(false)
})

it("sends native form bytes and preserves multipart boundary generation", async () => {
  const api = client()
  const foo = "a + b!~'()*"
  const result = await api.result("POST /echo", {
    body: { foo },
    headers: { "content-type": "application/x-www-form-urlencoded" },
  })
  expect(result.data?.body).toBe("foo=a+%2B+b%21%7E%27%28%29*")
  const form = new FormData()
  form.set("foo", "hello")
  const multipart = await api.result("POST /echo", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  })
  expect(multipart.data?.type).toMatch(/^multipart\/form-data; boundary=/)
  expect(multipart.data?.body).toContain('name="foo"')
})

it("closes its live HTTP response when the consumer cancels", async () => {
  const id = crypto.randomUUID()
  const reader = client().stream("GET /events", { query: { id }, retry: false }).getReader()
  try {
    expect(await reader.read()).toMatchObject({ value: { data: "live" } })
  } finally {
    await reader.cancel("finished")
  }
  const url = new URL("/closed", inject("browserBaseURL"))
  url.searchParams.set("id", id)
  await expect
    .poll(async () => {
      const response = await fetch(url)
      return (await response.json()) as boolean
    })
    .toBe(true)
})

it("keeps AbortSignal active after handing off response headers", async () => {
  const stop = new AbortController()
  const response = await client().fetch("GET /events", { signal: stop.signal })
  const reader = response.body?.getReader()
  expect(reader).toBeDefined()
  try {
    await reader?.read()
    const pending = reader?.read()
    stop.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  } finally {
    stop.abort()
    reader?.releaseLock()
  }
})
