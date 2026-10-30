import { expect, it } from "vitest"
import { ClientError, createClient } from "../../src/client"
import { CONTRACT_VERSION } from "../../src/shared/contract"

it.each(["result", "stream"] as const)("reports media diagnostics through %s", async (kind) => {
  const expected = kind === "result" ? "application/json" : "text/event-stream"
  const response = new Response("unexpected", { headers: { "content-type": "text/html" } })
  const api = createClient<{
    "GET /x": {
      responses: { 200: { content: { "application/json": object; "text/event-stream": object } } }
    }
  }>(
    {
      version: CONTRACT_VERSION,
      endpoints: { "GET /x": { responses: { 200: { content: { [expected]: {} } } } } },
    },
    { baseURL: "https://example.test", fetch: () => Promise.resolve(response) },
  )
  const pending = kind === "result" ? api.result("GET /x") : api.stream("GET /x").getReader().read()
  const failure: unknown = await pending.catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure).toBeInstanceOf(ClientError)
  expect(failure).toMatchObject({
    name: "ClientError",
    code: "UNEXPECTED_MEDIA_TYPE",
    details: { response, expected: [expected], actual: "text/html" },
  })
  expect(response.bodyUsed).toBe(true)
})

it("preserves cause identity without exposing diagnostic fields on unrelated codes", () => {
  const cause = new SyntaxError("Invalid record")
  const error = new ClientError(
    "Invalid JSON stream record at line 2",
    {
      code: "INVALID_STREAM_RECORD",
      details: { line: 2 },
    },
    { cause },
  )
  expect(error.cause).toBe(cause)
  expect(error.details).toStrictEqual({ line: 2 })
  expect(error).not.toBeInstanceOf(SyntaxError)
})
