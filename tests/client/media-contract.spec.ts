import { expect, it } from "vitest"
import { ContractResponseError, createClient } from "../../src/client"
import { matchDeclaredMedia } from "../../src/client/media"
import { resolveResponseDeclaration } from "../../src/client/response"
import { CONTRACT_VERSION } from "../../src/shared/contract"

it("rejects content for a declared empty representation but honors bodyless HTTP statuses", async () => {
  const response = new Response("unexpected")
  const api = createClient<{
    "GET /empty": { responses: { "200": Record<never, never>; "204": Record<never, never> } }
  }>(
    {
      version: CONTRACT_VERSION,
      endpoints: { "GET /empty": { responses: { "200": {}, "204": {} } } },
    },
    { baseURL: "https://example.test", fetch: () => Promise.resolve(response) },
  )
  await expect(api.result("GET /empty")).rejects.toBeInstanceOf(ContractResponseError)
  const empty = createClient<{ "HEAD /empty": { responses: { "200": Record<never, never> } } }>(
    {
      version: CONTRACT_VERSION,
      endpoints: { "HEAD /empty": { responses: { "200": {} } } },
    },
    {
      baseURL: "https://example.test",
      fetch: () =>
        Promise.resolve(new Response(null, { headers: { "content-type": "text/event-stream" } })),
    },
  )
  const result = await empty.result("HEAD /empty")
  expect(result.data).toBeUndefined()
})

it("matches parameterized media and status precedence", () => {
  const content = {
    "application/*": {},
    "application/json": {},
    'application/json; profile="https://example.test/p"': {},
  }
  expect(
    matchDeclaredMedia(
      content,
      'Application/JSON; charset=utf-8; profile="https://example.test/p"',
    ),
  ).toBe('application/json; profile="https://example.test/p"')
  expect(matchDeclaredMedia(content, "application/json; profile=other")).toBe("application/json")
  expect(
    matchDeclaredMedia({ "application/json; profile=one": {} }, "application/json; profile=two"),
  ).toBeUndefined()
  const endpoint = {
    responses: {
      "200": { content: { "application/json": {} } },
      "2XX": {},
      "default": { content: { "application/problem+json": {} } },
    },
  }
  expect(resolveResponseDeclaration(endpoint, 200)).toBe(endpoint.responses["200"])
  expect(resolveResponseDeclaration(endpoint, 201)).toBe(endpoint.responses["2XX"])
  expect(resolveResponseDeclaration(endpoint, 400)).toBe(endpoint.responses.default)
  expect(() => createClient({ version: CONTRACT_VERSION - 1, endpoints: {} } as never)).toThrow(
    "regenerate",
  )
})

it("uses the same header merge for stream selection and requests", async () => {
  await Promise.all(
    (
      [{ accept: "text/event-stream", Accept: "text/event-stream" }, { accept: undefined }] as const
    ).map(async (headers) => {
      const api = createClient<{
        "GET /events": { responses: { 200: { content: { "text/event-stream": unknown } } } }
      }>(
        {
          version: CONTRACT_VERSION,
          endpoints: {
            "GET /events": { responses: { 200: { content: { "text/event-stream": {} } } } },
          },
        },
        {
          baseURL: "https://example.test",
          fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        },
      )
      const reader = api.stream("GET /events", { headers, retry: { maxRetries: 0 } }).getReader()
      expect(await reader.read()).toStrictEqual({ done: true, value: undefined })
      reader.releaseLock()
    }),
  )
})

it("retains an empty Blob for declared wildcard content", async () => {
  const api = createClient<{
    "GET /empty": { responses: { 200: { content: { "*/*": number } } } }
  }>(
    {
      version: CONTRACT_VERSION,
      endpoints: { "GET /empty": { responses: { 200: { content: { "*/*": {} } } } } },
    },
    {
      baseURL: "https://example.test",
      fetch: () => Promise.resolve(new Response(null)),
    },
  )
  const result = await api.result("GET /empty")
  expect(result.data).toBeInstanceOf(Blob)
  expect((result.data as Blob).size).toBe(0)
})

it("rejects filtered status zero even with an empty default response", async () => {
  const api = createClient<{ "GET /x": { responses: { default: object } } }>(
    { version: CONTRACT_VERSION, endpoints: { "GET /x": { responses: { default: {} } } } },
    { baseURL: "https://example.test", fetch: () => Promise.resolve(Response.error()) },
  )
  await expect(api.result("GET /x")).rejects.toBeInstanceOf(ContractResponseError)
})
