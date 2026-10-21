import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import type { Contract } from "../src/client"
import { generate } from "../src/core/index"
import { contractOf } from "./helpers/contract"
import { oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"
import { typecheck } from "./helpers/tsc"

const json = (schema: object) => ({ "application/json": { schema } })
const item = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" } },
}
const description = oas("3.1", {
  paths: {
    "/items/{ids}": {
      get: {
        parameters: [
          {
            name: "ids",
            in: "path",
            required: true,
            style: "label",
            explode: true,
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "tags",
            in: "query",
            required: true,
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
          { name: "filter", in: "query", required: true, content: json(item) },
        ],
        responses: {
          "200": { description: "Found", content: json(item) },
          "204": { description: "Empty" },
          "304": { description: "Unchanged" },
          "404": {
            description: "Missing",
            content: json({
              type: "object",
              required: ["message"],
              properties: { message: { type: "string" } },
            }),
          },
        },
      },
    },
    "/items": {
      head: { responses: { "200": { description: "Exists", content: json(item) } } },
      post: {
        requestBody: {
          required: true,
          content: {
            ...json(item),
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["meta", "tags"],
                properties: {
                  meta: item,
                  tags: { type: "array", items: { type: "string" } },
                },
              },
              encoding: {
                meta: { contentType: "application/vnd.meta+json" },
                tags: { style: "form", explode: false },
              },
            },
          },
        },
        responses: { "204": { description: "Created" }, "400": { description: "Rejected" } },
      },
    },
  },
})

// Compile and execute this same consumer. Runtime assertions cannot accidentally exercise
// a different input than the one accepted by the generated public types.
const consumer = `
import { createClient } from "openapi-shape/client"
import type { contract } from "./api"

export async function run(generated: typeof contract, fetch: (request: Request) => Promise<Response>) {
  const api = createClient(generated, { baseUrl: "https://api.test", fetch })
  const input = { params: { ids: ["a/b", "c"] }, query: { tags: ["x&y", "z"], filter: { id: 7 } } }
  const results = []
  for (let i = 0; i < 4; i++) {
    const result = await api.result("GET /items/{ids}", input)
    if (result.status === 200) {
      result.data.id satisfies number
      // @ts-expect-error a success is not the error body
      result.data.message
    }
    if (result.status === 204) result.data satisfies undefined
    if (result.status === 304) result.error satisfies null
    if (result.status === 404 && result.error !== null) {
      result.error.message satisfies string
      // @ts-expect-error status narrows to the corresponding body
      result.error.id
    }
    results.push(result)
  }
  const head = await api.result("HEAD /items")
  head.data satisfies undefined
  results.push(head)
  const created = await api.result("POST /items", { body: { id: 7 } })
  if (created.status === 204) created.data satisfies undefined
  results.push(created)
  const rejected = await api.result("POST /items", {
    contentType: "multipart/form-data",
    body: { meta: { id: 7 }, tags: ["x&y", "z"] },
  })
  if (rejected.status === 400) rejected.error satisfies null
  results.push(rejected)
  return results
}

// Checked but never executed: the generated contract rejects these at the call site.
export function invalid(generated: typeof contract) {
  const api = createClient(generated)
  // @ts-expect-error required path and query parameters
  api.fetch("GET /items/{ids}")
  // @ts-expect-error filter uses its declared content schema
  api.fetch("GET /items/{ids}", { params: { ids: ["a"] }, query: { tags: [], filter: "raw" } })
  // @ts-expect-error the default application/json body requires id
  api.fetch("POST /items", { body: { meta: { id: 7 }, tags: [] } })
  // @ts-expect-error explicit media type selects its own body schema
  api.fetch("POST /items", { contentType: "multipart/form-data", body: { id: 7 } })
  // @ts-expect-error HEAD cannot send a body
  api.fetch("HEAD /items", { body: { id: 7 } })
}
`

it("preserves one generated protocol contract through type checking, encoding and decoding", async () => {
  const { code, diagnostics } = await generate(description)
  expect(diagnostics).toStrictEqual([])
  const clientPath = join(import.meta.dirname, "../src/client/index.ts")
  expect(
    await typecheck(
      {
        "api.ts": code,
        "consumer.ts": consumer,
      },
      { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
    ),
  ).toBe("")

  const contract = await contractOf(code)
  const requests: Request[] = []
  const responses = [
    Response.json({ id: 7 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 304 }),
    Response.json({ message: "missing" }, { status: 404 }),
    // Even if an injected transport supplies bytes, HEAD cannot expose a decoded body.
    Response.json({ id: 99 }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 400 }),
  ]
  const results = await withFiles(
    { "consumer.ts": consumer.replace('"openapi-shape/client"', JSON.stringify(clientPath)) },
    async (dir) => {
      const { run } = (await import(pathToFileURL(join(dir, "consumer.ts")).href)) as {
        run: (
          generated: Contract,
          fetch: (request: Request) => Promise<Response>,
        ) => Promise<unknown[]>
      }
      return run(contract, (request) => {
        requests.push(request)
        const response = responses.shift()
        if (!response) throw new Error("Unexpected extra request")
        return Promise.resolve(response)
      })
    },
  )
  expect(responses).toHaveLength(0)
  expect(results).toMatchObject([
    { status: 200, data: { id: 7 }, error: undefined },
    { status: 204, data: undefined, error: undefined },
    { status: 304, data: undefined, error: null },
    { status: 404, data: undefined, error: { message: "missing" } },
    { status: 200, data: undefined, error: undefined },
    { status: 204, data: undefined, error: undefined },
    { status: 400, data: undefined, error: null },
  ])
  expect(requests.slice(0, 4).map((request) => request.url)).toStrictEqual(
    Array(4).fill("https://api.test/items/.a%2Fb.c?tags=x%26y,z&filter=%7B%22id%22%3A7%7D"),
  )
  expect(requests[4].method).toBe("HEAD")
  expect(requests[4].body).toBeNull()
  expect(requests[5].headers.get("content-type")).toBe("application/json")
  expect(await requests[5].json()).toStrictEqual({ id: 7 })
  expect(requests[6].headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
  const parts = await requests[6].formData()
  expect([...parts.keys()]).toStrictEqual(["meta", "tags"])
  const meta = parts.get("meta")
  expect(meta).toBeInstanceOf(Blob)
  if (!(meta instanceof Blob)) throw new Error("Expected a typed JSON part")
  expect(meta.type).toBe("application/vnd.meta+json")
  expect(await meta.text()).toBe('{"id":7}')
  expect(parts.get("tags")).toBe("x&y,z")
})
