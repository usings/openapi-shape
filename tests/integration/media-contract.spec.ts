import { expect, it, vi } from "vitest"
import { ContractResponseError, createClient } from "../../src/client"
import { contractOf } from "../support/contract"
import { gen, oas } from "../support/generate"
import { typecheck } from "../support/tsc"

const document = oas("3.1", {
  paths: {
    "/items": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { id: { type: "number" } } },
              },
              "text/event-stream": {},
            },
          },
          "400": { content: { "application/problem+json": {} } },
          "204": {},
        },
      },
    },
  },
})

it("retains status/media declarations without generated defaults or capability lists", async () => {
  const contract = await contractOf(await gen(document))
  expect(contract.endpoints["POST /items"]).toStrictEqual({
    requestBody: { required: true, content: { "application/json": {} } },
    responses: {
      "200": { content: { "application/json": {}, "text/event-stream": {} } },
      "400": { content: { "application/problem+json": {} } },
      "204": {},
    },
  })
})

it("associates typed headers with bodies and preserves mixed endpoint result calls", async () => {
  expect(
    await typecheck({
      "api.ts": await gen(document),
      "use.ts": `
      import { createClient } from "openapi-shape/client"
      import { contract } from "./api"
      const api = createClient(contract)
      api.result("POST /items", { headers: { "Content-Type": "application/json", Accept: "application/json, application/problem+json;q=0.5" }, body: { name: "x" } })
      api.result("POST /items", { body: { name: "x" } })
      // @ts-expect-error media and body remain associated
      api.result("POST /items", { headers: { "content-type": "application/json" }, body: { name: 1 } })
      // @ts-expect-error opaque Headers cannot prove the structured body's media
      api.result("POST /items", { headers: new Headers({ "content-type": "application/json" }), body: { name: "x" } })
    `,
    }),
  ).toBe("")
})

it("defaults structured requests to JSON in the client without adding contract metadata", async () => {
  const contract = await contractOf(await gen(document))
  let sent: Request | undefined
  const api = createClient(contract, {
    baseURL: "https://example.test",
    fetch: (request) => {
      sent = request
      return Promise.resolve(Response.json({ id: 1 }))
    },
  })
  await api.result("POST /items", { body: { name: "Milo" } } as never)
  expect(sent?.headers.get("content-type")).toBe("application/json")
  expect(await sent?.json()).toStrictEqual({ name: "Milo" })
  expect(contract.endpoints["POST /items"]).not.toHaveProperty("contentType")
})

it("validates required bodies and rejects undeclared response media without leaking their bodies", async () => {
  const cancel = vi.fn<(reason?: unknown) => void>()
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { "content-type": "text/plain" },
  })
  const fetch = vi.fn<(request: Request) => Promise<Response>>().mockResolvedValue(response)
  const api = createClient(await contractOf(await gen(document)), {
    baseURL: "https://example.test",
    fetch,
  })
  await expect(api.fetch("POST /items" as never)).rejects.toThrow("requires a request body")
  expect(fetch).not.toHaveBeenCalled()
  await expect(
    api.result("POST /items", {
      headers: { "content-type": "application/json" },
      body: { name: "x" },
    } as never),
  ).rejects.toBeInstanceOf(ContractResponseError)
  expect(cancel).toHaveBeenCalledOnce()
})

it("rejects conflicting media headers before transport", async () => {
  const fetch = vi.fn<(request: Request) => Promise<Response>>()
  const api = createClient(await contractOf(await gen(document)), {
    baseURL: "https://example.test",
    fetch,
  })
  await expect(
    api.fetch("POST /items", {
      headers: { "content-type": "application/json", "Content-Type": "text/plain" },
      body: { name: "x" },
    } as never),
  ).rejects.toThrow("Conflicting content-type")
  expect(fetch).not.toHaveBeenCalled()
})

it("rejects an undeclared status before decoding and cancels its body", async () => {
  const cancel = vi.fn<() => void>()
  const api = createClient(await contractOf(await gen(document)), {
    baseURL: "https://example.test",
    fetch: () => Promise.resolve(new Response(new ReadableStream({ cancel }), { status: 201 })),
  })
  await expect(api.result("POST /items", { body: { name: "x" } } as never)).rejects.toThrow(
    "status is not declared",
  )
  expect(cancel).toHaveBeenCalledOnce()
})

it("infers literal client media defaults and requires proof for opaque defaults", async () => {
  expect(
    await typecheck({
      "use.ts": `
      import { createClient, type Contract } from "openapi-shape/client"
      type E = { "POST /x": { body: { "application/json": { name: string }, "application/x-www-form-urlencoded": { count: number } }, responses: {200: {content: {"application/json": unknown}}} } }
      declare const contract: Contract<E>
      const form = createClient(contract, {headers: {"content-type": "application/x-www-form-urlencoded"}})
      form.fetch("POST /x", {body: {count: 1}})
      // @ts-expect-error default media associates the body
      form.fetch("POST /x", {body: {name: "x"}})
      const opaque = createClient(contract, {headers: new Headers()})
      // @ts-expect-error opaque defaults cannot prove media
      opaque.fetch("POST /x", {body: {name: "x"}})
      opaque.fetch("POST /x", {headers: {"content-type": "application/json"}, body: {name: "x"}})
      declare const dynamicHeaders: HeadersInit | undefined
      const dynamic = createClient(contract, { headers: dynamicHeaders })
      // @ts-expect-error optional dynamic defaults may change the media
      dynamic.fetch("POST /x", { body: { name: "x" } })
      type W = { "POST /wild": { body: { "application/*": {name: string} }, responses: {200: {content: {"application/json": unknown}}} } }
      declare const wildcard: Contract<W>
      createClient(wildcard).fetch("POST /wild", {body: {name: "x"}})
      // @ts-expect-error the JSON fallback keeps the wildcard schema
      createClient(wildcard).fetch("POST /wild", {body: {name: 1}})
      const json = createClient(contract)
      json.fetch("POST /x", {body: {name: "x"}})
    `,
    }),
  ).toBe("")
})

it("rejects a different declared stream profile before delivering an item", async () => {
  const first = "application/x-ndjson; profile=a"
  const second = "application/x-ndjson; profile=b"
  const cancel = vi.fn<() => void>()
  const contract = await contractOf(
    await gen(
      oas("3.1", {
        paths: {
          "/s": { get: { responses: { 200: { content: { [first]: {}, [second]: {} } } } } },
        },
      }),
    ),
  )
  const api = createClient(contract, {
    baseURL: "https://example.test",
    fetch: () =>
      Promise.resolve(
        new Response(new ReadableStream({ cancel }), { headers: { "content-type": second } }),
      ),
  })
  await expect(
    api
      .stream("GET /s" as never, { headers: { accept: first } } as never)
      .getReader()
      .read(),
  ).rejects.toThrow("unused")
  expect(cancel).toHaveBeenCalledOnce()
})

it("checks header names case-insensitively without losing body associations", async () => {
  expect(
    await typecheck({
      "use.ts": `
      import {createClient, type Contract} from "openapi-shape/client"
      type E = {"POST /x": {headers: {"X-Mode": "safe"}, body: {"application/json": {json: number}, "application/x-www-form-urlencoded": {form: string}}, responses: {200: {}}}}
      declare const contract: Contract<E>
      const api = createClient(contract)
      api.fetch("POST /x", {headers: {"CONTENT-TYPE": "application/x-www-form-urlencoded"}, body: {form: "ok"}})
      // @ts-expect-error the actual media selects the form schema
      api.fetch("POST /x", {headers: {"CONTENT-TYPE": "application/x-www-form-urlencoded"}, body: {json: 1}})
      // @ts-expect-error declared header types apply to every spelling
      api.fetch("POST /x", {headers: {"x-mode": "unsafe"}, body: {json: 1}})
      const form = createClient(contract, {headers: {"CONTENT-TYPE": "application/x-www-form-urlencoded"}})
      form.fetch("POST /x", {body: {form: "ok"}})
    `,
    }),
  ).toBe("")
})
