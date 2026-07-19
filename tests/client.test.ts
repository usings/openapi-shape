import { describe, expect, it, vi } from "vitest"
import { createClient } from "../src/client"
import type { Adapter, Client, ResultOf, SuccessOf } from "../src/client"

interface TestAPI {
  "GET /pets": {
    params: void
    query: { limit?: number }
    body: void
    response: { "200": Array<{ id: number; name: string }> }
  }
  "POST /pets": {
    params: void
    query: void
    body: { name: string }
    response: { "200": { id: number } }
  }
  "GET /pets/{petId}": {
    params: { petId: string }
    query: void
    body: void
    response: { "200": { id: number; name: string } }
  }
  "DELETE /pets/{petId}/tags/{tagId}": {
    params: { petId: string; tagId: string }
    query: void
    body: void
    response: { "200": void }
  }
  "GET /search": {
    params: void
    query: { q: string; page?: number }
    body: void
    response: { "200": string[] }
  }
  "POST /upload": {
    params: void
    query: void
    body: { file: Blob; name: string }
    response: { "200": { url: string } }
  }
}

describe("createClient", () => {
  it("calls adapter with correct method and url", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter)

    await api("GET /pets")

    expect(adapter).toHaveBeenCalledWith({
      method: "GET",
      url: "/pets",
      body: undefined,
      headers: {},
    })
  })

  it("throws when endpoint key does not include a path", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<{
      GET: {
        params: void
        query: void
        body: void
        response: { "200": void }
      }
    }>(adapter)

    await expect(api("GET")).rejects.toThrow("Invalid endpoint: GET")
    expect(adapter).not.toHaveBeenCalled()
  })

  it("appends query parameters to url", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter)

    await api("GET /pets", { query: { limit: 10 } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/pets?limit=10")
  })

  it("appends array query parameters as repeated keys", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter)

    await api("GET /search", { query: { q: "cat", tags: ["small", "short hair"] } as any })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/search?q=cat&tags=small&tags=short+hair")
  })

  it("supports custom query serialization", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter, {
      serializeQuery(query) {
        return Object.entries(query)
          .filter(([, value]) => value != null)
          .map(([name, value]) => {
            const serializedValue = Array.isArray(value) ? value.join(",") : String(value)
            return `${encodeURIComponent(name)}=${encodeURIComponent(serializedValue)}`
          })
          .join("&")
      },
    })

    await api("GET /search", { query: { q: "cat", tags: ["small", "short hair"] } as any })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/search?q=cat&tags=small%2Cshort%20hair")
  })

  it("allows custom query serializer to return a leading question mark", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter, {
      serializeQuery: () => "?q=cat",
    })

    await api("GET /search", { query: { q: "ignored" } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/search?q=cat")
  })

  it("replaces path parameters", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1, name: "Buddy" })
    const api = createClient<TestAPI>(adapter)

    await api("GET /pets/{petId}", { params: { petId: "123" } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/pets/123")
  })

  it("replaces multiple path parameters", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<TestAPI>(adapter)

    await api("DELETE /pets/{petId}/tags/{tagId}", {
      params: { petId: "1", tagId: "2" },
    })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/pets/1/tags/2")
  })

  it("replaces repeated path parameter placeholders", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<{
      "GET /items/{id}/related/{id}": {
        params: { id: string }
        query: void
        body: void
        response: { "200": void }
      }
    }>(adapter)

    await api("GET /items/{id}/related/{id}", { params: { id: "x/y" } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/items/x%2Fy/related/x%2Fy")
  })

  it("stringifies non-string path parameter values before encoding", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<{
      "GET /pets/{petId}": {
        params: { petId: number }
        query: void
        body: void
        response: { "200": void }
      }
    }>(adapter)

    await api("GET /pets/{petId}", { params: { petId: 123 } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/pets/123")
  })

  it("throws when a path parameter remains unresolved", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<{
      "GET /pets/{petId}/tags/{tagId}": {
        params: { petId: string }
        query: void
        body: void
        response: { "200": void }
      }
    }>(adapter)

    await expect(api("GET /pets/{petId}/tags/{tagId}", { params: { petId: "1" } })).rejects.toThrow(
      "Missing path param: tagId",
    )
    expect(adapter).not.toHaveBeenCalled()
  })

  it("throws when a path parameter value is nullish", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<TestAPI>(adapter)

    await expect(api("GET /pets/{petId}", { params: { petId: undefined as any } })).rejects.toThrow(
      "Missing path param: petId",
    )
    expect(adapter).not.toHaveBeenCalled()
  })

  it("serializes plain object body as JSON", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1 })
    const api = createClient<TestAPI>(adapter)

    await api("POST /pets", { body: { name: "Buddy" } })

    const call = adapter.mock.calls[0][0]
    expect(call.method).toBe("POST")
    expect(call.body).toBe('{"name":"Buddy"}')
    expect(call.headers).toStrictEqual({ "content-type": "application/json" })
  })

  it("supports custom body serialization", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1 })
    const api = createClient<TestAPI>(adapter, {
      serializeBody(body) {
        return {
          body: String((body as { name: string }).name),
          headers: { "Content-Type": "text/plain" },
        }
      },
    })

    await api("POST /pets", { body: { name: "Buddy" } })

    const call = adapter.mock.calls[0][0]
    expect(call.body).toBe("Buddy")
    expect(call.headers).toStrictEqual({ "content-type": "text/plain" })
  })

  it("merges per-call headers on top of custom body headers", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1 })
    const api = createClient<TestAPI>(adapter, {
      serializeBody() {
        return {
          body: "Buddy",
          headers: { "Content-Type": "text/plain", "X-Body": "1" },
        }
      },
    })

    await api("POST /pets", {
      body: { name: "Buddy" },
      headers: { "Content-Type": "application/custom" },
    })

    const call = adapter.mock.calls[0][0]
    expect(call.headers).toStrictEqual({
      "content-type": "application/custom",
      "x-body": "1",
    })
  })

  it.each([
    [
      "FormData",
      () => {
        const form = new FormData()
        form.append("name", "test")
        return form
      },
    ],
    ["URLSearchParams", () => new URLSearchParams({ name: "Buddy" })],
    ["Blob", () => new Blob(["hello"], { type: "text/plain" })],
    ["ArrayBuffer", () => new ArrayBuffer(4)],
    ["Uint8Array", () => new Uint8Array([1, 2, 3])],
    [
      "ReadableStream",
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          },
        }),
    ],
  ])("passes %s body through without setting Content-Type", async (_name, makeBody) => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ url: "https://..." })
    const api = createClient<TestAPI>(adapter)

    const body = makeBody()
    await api("POST /upload", { body })

    const call = adapter.mock.calls[0][0]
    expect(call.body).toBe(body)
    expect(call.headers).toStrictEqual({})
  })

  it("serializes string body as JSON like any other declared value", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({})
    const api = createClient<{
      "POST /raw": {
        params: void
        query: void
        body: string
        response: { "200": void }
      }
    }>(adapter)

    await api("POST /raw", { body: "hello world" })

    const call = adapter.mock.calls[0][0]
    expect(call.body).toBe('"hello world"')
    expect(call.headers).toStrictEqual({ "content-type": "application/json" })
  })

  it("omits body and headers for no body", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter)

    await api("GET /pets")

    const call = adapter.mock.calls[0][0]
    expect(call.body).toBeUndefined()
    expect(call.headers).toStrictEqual({})
  })

  it("skips undefined query params", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter)

    await api("GET /search", { query: { q: "hello", page: undefined as any } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/search?q=hello")
  })

  it("encodes path parameter values", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1, name: "test" })
    const api = createClient<TestAPI>(adapter)

    await api("GET /pets/{petId}", { params: { petId: "a/b" } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/pets/a%2Fb")
  })

  it("returns adapter result", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([{ id: 1, name: "Buddy" }])
    const api = createClient<TestAPI>(adapter)

    const result = await api("GET /pets")
    expect(result).toStrictEqual([{ id: 1, name: "Buddy" }])
  })

  it.each([
    ["https://api.example.com"],
    ["https://api.example.com/"],
    ["https://api.example.com///"],
  ])("prepends baseURL %s and strips trailing slashes", async (baseURL) => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter, { baseURL })

    await api("GET /pets")

    expect(adapter.mock.calls[0][0].url).toBe("https://api.example.com/pets")
  })

  it("bypasses baseURL when endpoint path is an absolute URL", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<{
      "GET https://other.example.com/hook": {
        params: void
        query: { token: string }
        body: void
        response: { "200": void }
      }
    }>(adapter, { baseURL: "https://api.example.com" })

    await api("GET https://other.example.com/hook", { query: { token: "x" } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("https://other.example.com/hook?token=x")
  })

  it("keeps falsy but defined query values (0, false, empty string)", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter)

    await api("GET /search", {
      query: { q: "", page: 0, extra: false as any } as any,
    })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/search?q=&page=0&extra=false")
  })

  it("appends query parameters after an existing query string", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<{
      "GET /search?sort=name": {
        params: void
        query: { q: string }
        body: void
        response: { "200": string[] }
      }
    }>(adapter)

    await api("GET /search?sort=name", { query: { q: "cat" } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/search?sort=name&q=cat")
  })

  it("keeps url hash after appended query parameters", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<{
      "GET /search#items": {
        params: void
        query: { q: string }
        body: void
        response: { "200": string[] }
      }
    }>(adapter)

    await api("GET /search#items", { query: { q: "cat" } })

    const call = adapter.mock.calls[0][0]
    expect(call.url).toBe("/search?q=cat#items")
  })

  it("merges per-call headers on top of body Content-Type", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({})
    const api = createClient<TestAPI>(adapter)

    await api("POST /pets", {
      body: { name: "x" },
      headers: { "X-Trace-Id": "abc" },
    })

    const call = adapter.mock.calls[0][0]
    expect(call.headers).toStrictEqual({
      "content-type": "application/json",
      "x-trace-id": "abc",
    })
  })

  it("per-call header overrides the auto-set content-type case-insensitively", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({})
    const api = createClient<TestAPI>(adapter)

    await api("POST /pets", {
      body: { name: "x" },
      headers: { "content-type": "text/plain" },
    })

    const call = adapter.mock.calls[0][0]
    expect(call.headers).toStrictEqual({ "content-type": "text/plain" })
  })

  it("merges default headers before body and per-call headers", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({})
    const api = createClient<TestAPI>(adapter, {
      headers: {
        "Content-Type": "text/plain",
        "X-App": "docs",
        "X-Trace-Id": "default",
      },
    })

    await api("POST /pets", {
      body: { name: "x" },
      headers: { "X-Trace-Id": "call" },
    })

    const call = adapter.mock.calls[0][0]
    expect(call.headers).toStrictEqual({
      "content-type": "application/json",
      "x-app": "docs",
      "x-trace-id": "call",
    })
  })

  it("trims header names and skips empty header names", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({})
    const api = createClient<TestAPI>(adapter, {
      headers: {
        " X-App ": "docs",
        "": "empty",
        "   ": "blank",
      },
    })

    await api("GET /pets", {
      headers: { " X-Trace-Id ": "abc" },
    })

    const call = adapter.mock.calls[0][0]
    expect(call.headers).toStrictEqual({
      "x-app": "docs",
      "x-trace-id": "abc",
    })
  })

  it("throws when JSON body serialization returns undefined", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({})
    const api = createClient<TestAPI>(adapter)

    await expect(api("POST /pets", { body: (() => undefined) as any })).rejects.toThrow(
      "Request body cannot be serialized as JSON",
    )
    expect(adapter).not.toHaveBeenCalled()
  })

  it("throws with context when JSON body serialization fails", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({})
    const api = createClient<TestAPI>(adapter)
    const body: Record<string, unknown> = {}
    body.self = body

    await expect(api("POST /pets", { body: body as any })).rejects.toThrow(
      "Failed to serialize request body as JSON",
    )
    expect(adapter).not.toHaveBeenCalled()
  })

  interface AdapterOptions {
    timeout?: number
    tag?: string
    retry?: number
  }

  it.each<{
    name: string
    defaults: AdapterOptions | undefined
    perCall: AdapterOptions | undefined
    expected: AdapterOptions | undefined
  }>([
    {
      name: "per-call only",
      defaults: undefined,
      perCall: { timeout: 5000, tag: "v1" },
      expected: { timeout: 5000, tag: "v1" },
    },
    {
      name: "defaults only",
      defaults: { timeout: 5000, tag: "default" },
      perCall: undefined,
      expected: { timeout: 5000, tag: "default" },
    },
    {
      name: "per-call merged on top of defaults",
      defaults: { timeout: 5000, tag: "default" },
      perCall: { tag: "call", retry: 2 },
      expected: { timeout: 5000, tag: "call", retry: 2 },
    },
  ])("plain-object adapter options: $name", async ({ defaults, perCall, expected }) => {
    const adapter = vi.fn<Adapter<AdapterOptions>>().mockResolvedValue([])
    const api = createClient<TestAPI, AdapterOptions>(
      adapter,
      defaults ? { options: defaults } : undefined,
    )

    await api("GET /pets", perCall ? { options: perCall } : undefined)

    expect(adapter.mock.calls[0][0].options).toStrictEqual(expected)
  })

  it("uses per-call options when options are not objects", async () => {
    const adapter = vi.fn<Adapter<string>>().mockResolvedValue([])
    const api = createClient<TestAPI, string>(adapter, { options: "default" })

    await api("GET /pets", { options: "call" })

    const call = adapter.mock.calls[0][0]
    expect(call.options).toBe("call")
  })

  it("options is undefined when caller omits it", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api = createClient<TestAPI>(adapter)

    await api("GET /pets")

    const call = adapter.mock.calls[0][0]
    expect(call.options).toBeUndefined()
  })

  it("can be assigned to exported Client type", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue([])
    const api: Client<TestAPI> = createClient<TestAPI>(adapter)

    await api("GET /pets")

    expect(adapter).toHaveBeenCalledOnce()
  })
})

describe("createClient body optionality (type-level)", () => {
  interface OptAPI {
    "PATCH /x": {
      params: void
      query: void
      body?: { name: string }
      response: { "200": void }
    }
  }
  interface ReqAPI {
    "POST /x": {
      params: void
      query: void
      body: { name: string }
      response: { "200": void }
    }
  }
  interface NoBodyAPI {
    "GET /x": {
      params: void
      query: void
      body: void
      response: { "200": void }
    }
  }

  it("optional body: caller may omit body entirely", async () => {
    const adapter: Adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<OptAPI>(adapter)
    await api("PATCH /x")
    await api("PATCH /x", {})
    await api("PATCH /x", { body: { name: "x" } })
    expect(adapter).toBeDefined()
  })

  it("required body: caller must supply body", async () => {
    const adapter: Adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<ReqAPI>(adapter)
    await api("POST /x", { body: { name: "x" } })
    // @ts-expect-error: body is required
    await api("POST /x")
    // @ts-expect-error: body is required
    await api("POST /x", {})
    expect(adapter).toBeDefined()
  })

  it("body: void: caller must not pass body", async () => {
    const adapter: Adapter = vi.fn<Adapter>().mockResolvedValue(undefined)
    const api = createClient<NoBodyAPI>(adapter)
    await api("GET /x")
    // @ts-expect-error: body is not allowed
    await api("GET /x", { body: { foo: 1 } })
    expect(adapter).toBeDefined()
  })
})

describe("createClient response inference (type-level)", () => {
  it("uses default response when no 2xx response is declared", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ message: "ok" })
    const api = createClient<{
      "GET /fallback": {
        params: void
        query: void
        body: void
        response: {
          default: { message: string }
        }
      }
    }>(adapter)

    const result = await api("GET /fallback")
    const typed: { message: string } = result

    expect(typed).toStrictEqual({ message: "ok" })
  })

  it("prefers 2xx responses over default response", async () => {
    const adapter = vi.fn<Adapter>().mockResolvedValue({ id: 1 })
    const api = createClient<{
      "GET /fallback": {
        params: void
        query: void
        body: void
        response: {
          "200": { id: number }
          "default": { message: string }
        }
      }
    }>(adapter)

    const result = await api("GET /fallback")
    const typed: { id: number } = result

    expect(typed).toStrictEqual({ id: 1 })
  })
})

describe("client response helper types", () => {
  interface Endpoint {
    params: void
    query: void
    body: void
    response: {
      "200": { ok: true }
      "201": { created: true }
      "400": { badRequest: true }
      "4XX": { clientError: true }
      "500": { serverError: true }
      "5XX": { serverFamily: true }
      "default": { fallback: true }
    }
  }

  it("ResultOf extracts a response by exact status", () => {
    const result: ResultOf<Endpoint, "201"> = { created: true }

    expect(result).toStrictEqual({ created: true })
  })

  it("SuccessOf extracts all 2xx responses", () => {
    const result: SuccessOf<Endpoint> = { ok: true }
    const created: SuccessOf<Endpoint> = { created: true }

    expect(result).toStrictEqual({ ok: true })
    expect(created).toStrictEqual({ created: true })
  })

  it("SuccessOf falls back to default only when it is the sole response", () => {
    interface DefaultOnlyEndpoint {
      params: void
      query: void
      body: void
      response: {
        default: { fallback: true }
      }
    }
    interface DefaultAndErrorEndpoint {
      params: void
      query: void
      body: void
      response: {
        "400": { badRequest: true }
        "default": { fallback: true }
      }
    }

    const fallback: SuccessOf<DefaultOnlyEndpoint> = { fallback: true }
    const unknownSuccess = unknownValue() as SuccessOf<DefaultAndErrorEndpoint>
    // @ts-expect-error: default is not a success fallback when other responses exist
    unknownSuccess satisfies { fallback: true }

    expect(fallback).toStrictEqual({ fallback: true })
    expect(unknownSuccess).toBeUndefined()
  })

  it("ResultOf extracts exact 4xx/5xx responses", () => {
    const badRequest: ResultOf<Endpoint, "400"> = { badRequest: true }
    const serverError: ResultOf<Endpoint, "500"> = { serverError: true }

    expect(badRequest).toStrictEqual({ badRequest: true })
    expect(serverError).toStrictEqual({ serverError: true })
  })
})

function unknownValue(): unknown {
  return undefined
}
