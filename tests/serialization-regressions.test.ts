import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import type { Contract } from "../src/client"
import { createClient } from "../src/client"
import { generate } from "../src/index"
import { oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"
import { typecheck } from "./helpers/tsc"

const ok = { "200": { description: "OK" } }
const form = "application/x-www-form-urlencoded"

/** Exercise the generated contract through the real client, with a recording transport. */
async function generatedClient(document: object) {
  const { code, diagnostics } = await generate(document)
  expect(diagnostics).toStrictEqual([])
  const contract = await withFiles({ "api.ts": code }, async (dir) => {
    const module = (await import(pathToFileURL(join(dir, "api.ts")).href)) as {
      contract: Contract<
        Record<
          string,
          {
            query?: Record<string, unknown>
            body?: Record<typeof form | `${typeof form};${string}`, unknown>
            responses: object
          }
        >
      >
    }
    return module.contract
  })
  const requests: Request[] = []
  const client = createClient(contract, {
    baseUrl: "https://api.test",
    fetch: (request) => {
      requests.push(request)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  return { client, requests, contract }
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
  const { client, requests, contract } = await generatedClient(
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
  expect(contract.version).toBe(1)
})

it("requires narrowing wildcard results before accessing schema properties", async () => {
  const mediaSchema = {
    schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
  }
  const { code } = await generate(
    oas("3.1", {
      paths: Object.fromEntries(
        ["application/*", "*/*", "application/json"].map((media, i) => [
          `/r${i}`,
          {
            get: { responses: { "200": { description: "OK", content: { [media]: mediaSchema } } } },
          },
        ]),
      ),
    }),
  )
  expect(
    await typecheck({
      "api.ts": code,
      "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const client = createClient(contract)
async function check() {
  const app = await client.result("GET /r0")
  if (app.error === undefined) {
    app.data satisfies { id: number } | Blob
    // @ts-expect-error application/* may return a Blob
    app.data.id.toFixed()
    if (!(app.data instanceof Blob)) app.data.id.toFixed()
  }
  const any = await client.result("GET /r1")
  if (any.error === undefined) {
    any.data satisfies { id: number } | Blob | string
    // @ts-expect-error */* may also return text
    any.data.id.toFixed()
    if (typeof any.data !== "string" && !(any.data instanceof Blob)) any.data.id.toFixed()
  }
  const json = await client.result("GET /r2")
  if (json.error === undefined) json.data.id.toFixed()
  const raw = await client.fetch("GET /r0")
  if (raw.ok) (await raw.json()).id.toFixed()
}
`,
    }),
  ).toBe("")
})
