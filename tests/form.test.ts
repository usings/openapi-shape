import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import { createClient } from "../src/client"
import { generate } from "../src/core/index"
import type { ResultOperation } from "./helpers/contract"
import { contractOf } from "./helpers/contract"
import { oas } from "./helpers/generate"

const ok = { "200": { description: "OK" } }
const form = "application/x-www-form-urlencoded"

/** Exercise the generated contract through the real client, with a recording transport. */
async function generatedClient(document: object) {
  const { code, diagnostics } = await generate(document)
  expect(diagnostics).toStrictEqual([])
  const contract = await contractOf<
    Record<
      string,
      ResultOperation<{
        query?: Record<string, unknown>
        body?: unknown
        contentType?: typeof form | `${typeof form};${string}`
      }>
    >
  >(code)
  const requests: Request[] = []
  const client = createClient(contract, {
    baseUrl: "https://api.test",
    fetch: (request) => {
      requests.push(request)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  return { client, requests }
}

it("sends JSON null in query parameters and form fields while omitting absent values", async () => {
  const { client, requests } = await generatedClient(
    oas("3.1", {
      paths: {
        "/search": {
          post: {
            parameters: [
              {
                name: "filter",
                in: "query",
                required: true,
                content: { "application/json": { schema: { type: ["object", "null"] } } },
              },
            ],
            requestBody: {
              content: {
                [form]: {
                  schema: { type: "object" },
                  encoding: { filter: { contentType: "application/json" } },
                },
              },
            },
            responses: ok,
          },
        },
      },
    }),
  )
  await client.fetch("POST /search", {
    query: { filter: null, omitted: null },
    body: { filter: null, omitted: null, absent: undefined },
    contentType: form,
  })
  expect(new URL(requests[0].url).search).toBe("?filter=null")
  expect(await requests[0].text()).toBe("filter=null")
  await client.fetch("POST /search", { query: { filter: undefined } })
  expect(new URL(requests[1].url).search).toBe("")
})

it("selects form encodings by the full media type and keeps unconfigured variants at defaults", async () => {
  const compact = `${form};profile=compact`
  const expanded = `${form};profile=expanded`
  const schema = {
    type: "object",
    properties: { tags: { type: "array", items: { type: "string" } } },
  }
  const { client, requests } = await generatedClient(
    oas("3.1", {
      paths: {
        "/form": {
          post: {
            requestBody: {
              content: {
                [compact]: { schema, encoding: { tags: { explode: false } } },
                [expanded]: { schema, encoding: { tags: { explode: true } } },
                [form]: { schema },
              },
            },
            responses: ok,
          },
        },
      },
    }),
  )
  for (const contentType of [compact, expanded, form] as const) {
    // oxlint-disable-next-line no-await-in-loop -- inspect each independently encoded request
    await client.fetch("POST /form", { contentType, body: { tags: ["a", "b"] } })
  }
  expect(await Promise.all(requests.map((r) => r.text()))).toStrictEqual([
    "tags=a,b",
    "tags=a&tags=b",
    "tags=a&tags=b",
  ])
  expect(requests.map((r) => r.headers.get("content-type"))).toStrictEqual([
    compact,
    expanded,
    form,
  ])
})

it("encodes cross-realm form objects without treating class instances as records", async () => {
  const { client, requests } = await generatedClient(
    oas("3.1", {
      paths: {
        "/form": {
          post: {
            requestBody: {
              content: {
                [form]: {
                  schema: { type: "object" },
                  encoding: { filter: { style: "deepObject" } },
                },
              },
            },
            responses: ok,
          },
        },
      },
    }),
  )
  const body: Record<string, unknown> = runInNewContext(
    "({ filter: { ids: [1, 2] }, when: new Date(0) })",
  )
  await client.fetch("POST /form", { contentType: form, body })
  expect(await requests[0].text()).toBe(
    "filter[ids][0]=1&filter[ids][1]=2&when=1970-01-01T00%3A00%3A00.000Z",
  )
  const instance: Record<string, unknown> = runInNewContext(
    'new (class PretendObject { value = "not a record"; get [Symbol.toStringTag]() { return "Object" } })()',
  )
  await expect(client.fetch("POST /form", { contentType: form, body: instance })).rejects.toThrow(
    "A form body must be an object",
  )
})
