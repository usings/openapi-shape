import { describe, expect, it, vi } from "vitest"
import { createClient } from "../../src/client"
import type { BodyLike } from "../../src/client/types/request"
import { contract } from "../fixtures/output/client-api"
import { recorder, url } from "../support/client"
import type { ResultOperation } from "../support/contract"

async function* uploadChunks() {
  yield new Uint8Array([0, 65, 66, 0]).subarray(1, 3)
  yield new Uint8Array()
  yield new Uint8Array([67])
}

describe("contract validation", () => {
  it("refuses a base URL that would swallow the path", () => {
    expect(() => createClient(contract, { baseURL: "https://api.test/v1?k=1" })).toThrow(
      "has a query or fragment",
    )
    expect(() => createClient(contract, { baseURL: new URL("https://api.test/v1#top") })).toThrow(
      "has a query or fragment",
    )
  })

  it("requires the current version and an operations object, otherwise directs regeneration", () => {
    for (const given of [
      undefined,
      null,
      { endpoints: {} },
      { version: 4, endpoints: {} },
      { version: 5, endpoints: {} },
      { version: "5", endpoints: {} },
      { version: 7 },
      { version: 7, endpoints: null },
      { version: 7, endpoints: [] },
      { version: 7, endpoints: false },
      { version: 7, endpoints: "GET /a" },
    ]) {
      expect(() => createClient(given as never)).toThrow(TypeError)
      expect(() => createClient(given as never)).toThrow(
        "regenerate the module with this version of openapi-shape",
      )
    }
  })
})

describe("requests", () => {
  it.each(["fetch", "result"] as const)(
    "overrides baseURL for one %s call without changing later requests",
    async (method) => {
      const { client, requests } = recorder(
        contract,
        {
          baseURL: "https://api.test/v1/",
          headers: { "x-client": "shared" },
        },
        () => Response.json([]),
      )
      await client[method]("GET /pets/{id}", {
        baseURL: new URL("https://uploads.test/v2/"),
        params: { id: 7 },
      })
      await client[method]("GET /pets", { baseURL: undefined })
      expect(requests.map((request) => request.url)).toStrictEqual([
        "https://uploads.test/v2/pets/7",
        "https://api.test/v1/pets",
      ])
      expect(requests[0].headers.get("x-client")).toBe("shared")
    },
  )

  it("uses independent baseURL values for concurrent uploads and ordinary requests", async () => {
    const { client, requests } = recorder(contract, { baseURL: "https://api.test/v1" })
    await Promise.all([
      client.fetch("POST /upload", {
        baseURL: "https://uploads.test/files///",
        body: { file: new Blob(["portrait"]) },
        headers: { "content-type": "multipart/form-data" },
      }),
      client.result("GET /search", {
        baseURL: "https://search.test/v2",
        query: { q: "Milo & Luna" },
      }),
      client.fetch("GET /pets"),
    ])
    expect(requests.map((request) => request.url)).toStrictEqual([
      "https://uploads.test/files/upload",
      "https://search.test/v2/search?q=Milo%20%26%20Luna",
      "https://api.test/v1/pets",
    ])
    const form = await requests[0].formData()
    expect(await (form.get("file") as Blob).text()).toBe("portrait")
  })

  it.each(["https://uploads.test/v2?token=x", "https://uploads.test/v2#fragment"])(
    "rejects a per-call baseURL containing a query or fragment: %s",
    async (baseURL) => {
      const { client, requests } = recorder(contract)
      await expect(client.fetch("GET /pets", { baseURL })).rejects.toThrow("baseURL")
      await expect(client.result("GET /pets", { baseURL })).rejects.toThrow("baseURL")
      expect(requests).toHaveLength(0)
      await client.fetch("GET /pets")
      expect(requests[0].url).toBe("https://x.test/pets")
    },
  )

  it.each(["GET /missing", "toString", "constructor", "__proto__"])(
    "rejects endpoint %s absent from the own registry without sending",
    async (endpoint) => {
      const { client, requests } = recorder(contract)
      await expect(client.fetch(endpoint as never)).rejects.toThrow("Unknown endpoint")
      await expect(client.result(endpoint as never)).rejects.toThrow("Unknown endpoint")
      expect(requests).toHaveLength(0)
    },
  )

  it("splits endpoint keys at the first space and preserves custom method case", async () => {
    const { client, sent } = recorder<{ "customVerb /a b": ResultOperation }>({
      version: 7,
      endpoints: { "customVerb /a b": { responses: { default: { content: { "*/*": {} } } } } },
    })
    await client.fetch("customVerb /a b")
    expect([sent().method, url(sent())]).toStrictEqual(["customVerb", "/a%20b"])
  })

  it("rejects, sending nothing, when a request cannot be built", async () => {
    const { client, requests } = recorder(contract)
    await expect(client.fetch("GET /pets/{id}", {} as never)).rejects.toThrow(
      'Missing path parameter "id"',
    )
    // As `fetch` does for a request it cannot build.
    await expect(client.result("GET /pets/{id}", {} as never)).rejects.toBeInstanceOf(TypeError)
    expect(requests).toHaveLength(0)
  })

  it("merges headers, the call's over the client's, and serializes declared ones", async () => {
    const { client, sent } = recorder(contract, {
      headers: { "Authorization": "Bearer t", "X-Trace": "default" },
    })
    await client.fetch("GET /files/{names}", {
      params: { names: ["a"] },
      headers: { "x-trace": "call", "x-range": { from: 5 }, "x-list": ["a", "b"], "x-no": null },
    })
    expect(Object.fromEntries(sent().headers)).toStrictEqual({
      "authorization": "Bearer t",
      "x-trace": "call",
      "x-range": "from=5",
      "x-list": "a,b",
    })
  })

  it("takes a Headers or its entries as they are", async () => {
    const { client, sent } = recorder(contract, { headers: { "X-Trace": "default" } })
    await client.fetch("GET /pets", { headers: new Headers({ "X-Trace": "call", "X-Other": "o" }) })
    expect(Object.fromEntries(sent().headers)).toStrictEqual({ "x-trace": "call", "x-other": "o" })
    await client.fetch("GET /pets", { headers: [["x-trace", "entries"]] })
    expect(sent().headers.get("x-trace")).toBe("entries")
    // A Headers of another implementation, as undici's may be in Node.js.
    const foreign = {
      *[Symbol.iterator]() {
        yield ["x-trace", "foreign"]
      },
    }
    await client.fetch("GET /pets", { headers: foreign as unknown as Headers })
    expect(sent().headers.get("x-trace")).toBe("foreign")
    // From JavaScript, no headers at all.
    await client.fetch("GET /pets", { headers: null as never })
    expect(sent().headers.get("x-trace")).toBe("default")
  })

  it("applies RequestInit fields, the call's over the client's", async () => {
    const { client, sent } = recorder(contract, { cache: "no-store", redirect: "manual" })
    const controller = new AbortController()
    await client.fetch("GET /pets", { redirect: "error", signal: controller.signal })
    expect([sent().cache, sent().redirect]).toStrictEqual(["no-store", "error"])
    controller.abort()
    expect(sent().signal.aborted).toBe(true)
  })
})

describe("parameters", () => {
  describe("parameter serialization", () => {
    it("expands path parameters with simple style under the base URL", async () => {
      const { client, sent } = recorder(contract, { baseURL: "https://api.test/v1/" })
      await client.fetch("GET /pets/{id}", { params: { id: 7 } })
      expect([sent().method, sent().url]).toStrictEqual(["GET", "https://api.test/v1/pets/7"])
    })

    it("encodes path parameter values, arrays, and objects", async () => {
      const { client, sent } = recorder<{
        "GET /a/{x}/{y}/{z}": ResultOperation<{ params: { x: string; y: string[]; z: object } }>
      }>({
        version: 7,
        endpoints: {
          "GET /a/{x}/{y}/{z}": { responses: { default: { content: { "*/*": {} } } } },
        },
      })
      await client.fetch("GET /a/{x}/{y}/{z}", {
        params: { x: "雪/a b", y: ["1", "2"], z: { k: "v w" } },
      })
      expect(url(sent())).toBe("/a/%E9%9B%AA%2Fa%20b/1,2/k,v%20w")
    })

    it.each(["a/b", "a b", "a#b", "a?b", "a;b=c", "雪/名", "a\n/b"])(
      "expands the entire legal parameter name %s and escapes matrix names",
      async (name) => {
        const endpoint = `GET /files/{${name}}/tail`
        const { client, sent } = recorder<
          Record<string, ResultOperation<{ params: Record<string, unknown> }>>
        >({
          version: 7,
          endpoints: {
            [endpoint]: {
              parameters: {
                path: {
                  [name]: { required: false, encoding: { style: "matrix", allowReserved: true } },
                },
              },

              responses: { default: { content: { "*/*": {} } } },
            },
          },
        })
        await client.fetch(endpoint, { params: { [name]: "safe" } })
        expect(url(sent())).toBe(`/files/;${encodeURIComponent(name)}=safe/tail`)
        const exploded = recorder<
          Record<string, ResultOperation<{ params: Record<string, unknown> }>>
        >({
          version: 7,
          endpoints: {
            [endpoint]: {
              parameters: {
                path: { [name]: { required: false, encoding: { style: "matrix", explode: true } } },
              },
              responses: { default: { content: { "*/*": {} } } },
            },
          },
        })
        await exploded.client.fetch(endpoint, { params: { [name]: ["a", "b"] } })
        expect(url(exploded.sent())).toBe(
          `/files/;${encodeURIComponent(name)}=a;${encodeURIComponent(name)}=b/tail`,
        )
        const simple = recorder<
          Record<string, ResultOperation<{ params: Record<string, unknown> }>>
        >({
          version: 7,
          endpoints: {
            [endpoint]: { responses: { default: { content: { "*/*": {} } } } },
          },
        })
        await simple.client.fetch(endpoint, { params: { [name]: "safe" } })
        expect(url(simple.sent())).toBe("/files/safe/tail")
        await expect(simple.client.fetch(endpoint, { params: {} })).rejects.toThrow(
          "Missing path parameter",
        )
      },
    )

    it("preserves segment boundaries and traversal rejection around slash-bearing names", async () => {
      const { client, sent } = recorder<
        Record<string, ResultOperation<{ params: Record<string, unknown> }>>
      >({
        version: 7,
        endpoints: {
          "GET /files//prefix-{a/b}-{c/d}/": { responses: { default: { content: { "*/*": {} } } } },
          "GET /files/{a/b}/tail": {
            parameters: { path: { "a/b": { required: false, encoding: { allowReserved: true } } } },
            responses: { default: { content: { "*/*": {} } } },
          },
        },
      })
      await client.fetch("GET /files//prefix-{a/b}-{c/d}/", { params: { "a/b": "x", "c/d": "y" } })
      expect(url(sent())).toBe("/files//prefix-x-y/")
      for (const value of ["", ".", "..", "%2e%2E", "x/../y", "x//y"]) {
        // oxlint-disable-next-line no-await-in-loop -- each traversal case is independent
        await expect(
          client.fetch("GET /files/{a/b}/tail", { params: { "a/b": value } }),
        ).rejects.toThrow("another resource")
      }
    })

    it.each(["toString", "constructor", "__proto__", "id"])(
      "requires an own path parameter named %s",
      async (name) => {
        const endpoint = `GET /x/{${name}}`
        const { client, sent, requests } = recorder<
          Record<string, ResultOperation<{ params: Record<string, string> }>>
        >({
          version: 7,
          endpoints: { [endpoint]: { responses: { default: { content: { "*/*": {} } } } } },
        })
        const inherited = Object.create({ [name]: "inherited" }) as Record<string, string>
        await expect(client.fetch(endpoint, { params: {} })).rejects.toThrow(
          `Missing path parameter "${name}"`,
        )
        await expect(client.result(endpoint, { params: inherited })).rejects.toThrow(
          `Missing path parameter "${name}"`,
        )
        expect(requests).toHaveLength(0)
        await client.fetch(endpoint, { params: Object.fromEntries([[name, "own"]]) })
        expect(url(sent())).toBe("/x/own")
        const own = Object.assign(Object.create(null), { [name]: "null-prototype" }) as Record<
          string,
          string
        >
        await client.fetch(endpoint, { params: own })
        expect(url(sent())).toBe("/x/null-prototype")
      },
    )

    it("serializes the query with form style, exploding arrays and objects", async () => {
      const { client, sent } = recorder<{
        "GET /q?fixed=1": ResultOperation<{ query: Record<string, unknown> }>
      }>({
        version: 7,
        endpoints: {
          "GET /q?fixed=1": {
            parameters: { query: { compact: { required: false, encoding: { explode: false } } } },
            responses: { default: { content: { "*/*": {} } } },
          },
        },
      })
      const query = {
        a: [1, null, 2, undefined, 0, false, ""],
        b: null,
        c: { "d": true, "e": "x y", "nil": null, "a&b": "c=d" },
        f: "",
        g: new Date(0),
        empty: [],
        compact: [],
      }
      await client.fetch("GET /q?fixed=1", { query })
      expect(url(sent())).toBe(
        "/q?fixed=1&a=1&a=2&a=0&a=false&a=&d=true&e=x%20y&a%26b=c%3Dd&f=&g=1970-01-01T00%3A00%3A00.000Z&compact=",
      )
    })

    it("serializes sparse deep fields without invoking methods on the input array", async () => {
      const { client, sent } = recorder<{
        "GET /q": ResultOperation<{ query: Record<string, unknown> }>
      }>({
        version: 7,
        endpoints: {
          "GET /q": {
            parameters: {
              query: { filter: { required: false, encoding: { style: "deepObject" } } },
            },
            responses: { default: { content: { "*/*": {} } } },
          },
        },
      })
      const items = Object.assign(Array<string | undefined>(4), {
        forEach: () => {
          throw new Error("Do not call a method on the input")
        },
      })
      items[2] = "a/b &+"
      const filter = Object.assign(Object.create(null), {
        items,
        omit: null,
        empty: {},
        flag: false,
      })
      await client.fetch("GET /q", { query: { filter } })
      expect(url(sent())).toBe("/q?filter[items][2]=a%2Fb%20%26%2B&filter[flag]=false")
      await expect(
        client.fetch("GET /q", {
          query: { filter: { invalidUnicode: "\uD800", blob: new Blob(["x"]) } },
        }),
      ).rejects.toThrow("A Blob cannot be sent as text")
    })

    it("normalizes parameter content types before encoding their values", async () => {
      const { client, sent } = recorder<{
        "GET /q": ResultOperation<{ query: Record<string, unknown> }>
      }>({
        version: 7,
        endpoints: {
          "GET /q": {
            parameters: {
              query: {
                json: {
                  required: false,
                  encoding: { contentType: " \tApplication/Problem+JSON ; p=*" },
                },
                wild: { required: false, encoding: { contentType: "Application/*" } },
                text: { required: false, encoding: { contentType: "TEXT/PLAIN; charset=utf-8" } },
              },
            },

            responses: { default: { content: { "*/*": {} } } },
          },
        },
      })
      await client.fetch("GET /q", { query: { json: "value", wild: "value", text: "value" } })
      expect(url(sent())).toBe("/q?json=%22value%22&wild=%22value%22&text=value")
    })

    it("serializes parameters in their declared styles", async () => {
      const { client, sent } = recorder(contract)
      const query = { created: { gte: 1 }, expand: ["customer", "invoice"], ids: ["x", "y"] }
      await client.fetch("GET /charges", { query })
      expect(url(sent())).toBe(
        "/charges?created[gte]=1&expand[0]=customer&expand[1]=invoice&ids=x%7Cy",
      )
      await client.fetch("GET /files/{names}", { params: { names: ["a", "b"] } })
      expect(url(sent())).toBe("/files/.a,b")
    })
  })

  describe("reserved characters, delimiters, and path segments", () => {
    const { client, sent } = recorder<{
      "GET /files/{path}": ResultOperation<{ params: { path: string } }>
      "GET /q": ResultOperation<{ query: Record<string, unknown> }>
    }>({
      version: 7,
      endpoints: {
        "GET /files/{path}": {
          parameters: {
            path: {
              path: {
                required: false,
                encoding: { style: "simple", explode: false, allowReserved: true },
              },
            },
          },

          responses: { default: { content: { "*/*": {} } } },
        },
        "GET /q": {
          parameters: {
            query: {
              next: {
                required: false,
                encoding: { style: "form", explode: true, allowReserved: true },
              },
              ids: { required: false, encoding: { style: "form", explode: false } },
              sp: { required: false, encoding: { style: "spaceDelimited", explode: false } },
              pipe: { required: false, encoding: { style: "pipeDelimited", explode: false } },
              spArray: { required: false, encoding: { style: "spaceDelimited", explode: false } },
              pipeArray: { required: false, encoding: { style: "pipeDelimited", explode: false } },
            },
          },

          responses: { default: { content: { "*/*": {} } } },
        },
      },
    })

    it("keeps reserved characters only where they cannot change the URL", async () => {
      await client.fetch("GET /files/{path}", { params: { path: "a/b c%20d#e?f" } })
      expect(url(sent())).toBe("/files/a/b%20c%20d%23e%3Ff")
      await client.fetch("GET /q", { query: { next: "a#b&c=d/e?f%20g+h" } })
      expect(url(sent())).toBe("/q?next=a%23b%26c%3Dd/e?f%20g%2Bh")
    })

    it("keeps commas between values, and percent-encodes spaces and pipes", async () => {
      const query = {
        ids: ["a,b", null, "c"],
        sp: { R: 100, G: 200 },
        pipe: { R: 100, G: 200 },
        spArray: ["a b", null, "c/d"],
        pipeArray: ["a b", null, "c/d"],
      }
      await client.fetch("GET /q", { query })
      expect(url(sent())).toBe(
        "/q?ids=a%2Cb,c&sp=R%20100%20G%20200&pipe=R%7C100%7CG%7C200&spArray=a%20b%20c%2Fd&pipeArray=a%20b%7Cc%2Fd",
      )
    })

    it("refuses path values that would reach another resource", async () => {
      for (const path of ["..", ".", "", "a/../b", "%2e", "%2e%2E", "/a", "a//b"]) {
        const call = client.fetch("GET /files/{path}", { params: { path } })
        // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
        await expect(call).rejects.toThrow("another resource")
        // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
        await expect(call).rejects.toBeInstanceOf(TypeError)
      }
    })
  })
})

describe("request bodies", () => {
  it("lets encoded multipart bodies supply their boundary over explicit headers", async () => {
    const { client, sent } = recorder(contract, {
      headers: { "content-type": "application/json" },
    })
    await client.fetch("POST /upload", {
      body: { file: new Blob(["payload"]) },
      headers: { "content-type": "multipart/form-data" },
    })
    expect(sent().headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
    const parts = await sent().formData()
    expect(await (parts.get("file") as Blob).text()).toBe("payload")
  })

  it("reserves native form headers while allowing overrides for encoded form text", async () => {
    const { client, sent } = recorder<{
      "POST /form": ResultOperation<{
        body: Record<"application/x-www-form-urlencoded", { name: string }>
      }>
    }>(
      {
        version: 7,
        endpoints: {
          "POST /form": {
            requestBody: {
              required: false,
              content: { "application/x-www-form-urlencoded": {} },
            },
            responses: { default: { content: { "*/*": {} } } },
          },
        },
      },
      { headers: { "content-type": "application/json" } },
    )
    await client.fetch("POST /form", {
      body: new URLSearchParams({ name: "a b" }),
      headers: new Headers({ "content-type": "text/plain" }),
    })
    expect(sent().headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    )
    expect(await sent().text()).toBe("name=a+b")
    await client.fetch("POST /form", {
      body: { name: "a b" },
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    expect(sent().headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(await sent().text()).toBe("name=a+b")
  })

  it("uses the selected header for encoding and transport", async () => {
    const { client, sent } = recorder(contract)
    await client.fetch("PATCH /pets/{id}", {
      params: { id: 1 },
      body: { name: "R" },
      headers: { "content-type": "application/merge-patch+json" },
    })
    expect(sent().headers.get("content-type")).toBe("application/merge-patch+json")
  })

  it("distinguishes an omitted body from empty text", async () => {
    const { client, sent } = recorder<{
      "POST /text": ResultOperation<{ body?: Record<string, string | BodyLike> }>
    }>({
      version: 7,
      endpoints: {
        "POST /text": {
          requestBody: { required: false, content: { "text/plain": {} } },
          responses: { default: { content: { "*/*": {} } } },
        },
      },
    })
    await client.fetch("POST /text")
    expect(sent().body).toBeNull()
    expect(sent().headers.has("content-type")).toBe(false)
    await client.fetch("POST /text", { headers: { "content-type": "text/plain" }, body: "" })
    expect(sent().body).not.toBeNull()
    expect(sent().headers.get("content-type")).toBe("text/plain")
    expect(await sent().text()).toBe("")
  })

  it("sends JSON by default, and other JSON media types as declared", async () => {
    const { client, sent } = recorder(contract)
    await client.fetch("POST /pets", {
      body: { name: "Rex" },
      headers: { "content-type": "application/json" },
    })
    expect(sent().headers.get("content-type")).toBe("application/json")
    expect(await sent().text()).toBe('{"name":"Rex"}')
    await client.fetch("PATCH /pets/{id}", {
      params: { id: 1 },
      body: { name: "R" },
      headers: { "content-type": "application/merge-patch+json" },
    })
    expect(sent().headers.get("content-type")).toBe("application/merge-patch+json")
  })

  it("passes ready-made bodies through, with their own or the declared type", async () => {
    const { client, sent } = recorder(contract, {
      headers: { "content-type": "application/json" },
    })
    const form = new FormData()
    form.append("name", "n")
    // A FormData's boundary is part of its own type, which no header replaces.
    await client.fetch("POST /upload", {
      body: form,
      headers: { "content-type": "multipart/form-data" },
    })
    expect(sent().headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
    const parts = await sent().formData()
    expect(parts.get("name")).toBe("n")
    await client.fetch("POST /upload", {
      body: new Uint8Array([1, 2]),
      headers: { "content-type": "application/octet-stream" },
    })
    expect(sent().headers.get("content-type")).toBe("application/octet-stream")
    expect(new Uint8Array(await sent().arrayBuffer())).toStrictEqual(new Uint8Array([1, 2]))
  })

  it("sends async iterable request bodies as bytes in the browser", async () => {
    const { client, sent } = recorder(contract)
    await client.fetch("POST /upload", {
      body: uploadChunks(),
      headers: { "content-type": "application/octet-stream" },
    })
    expect(await sent().text()).toBe("ABC")
    expect(sent().headers.get("content-type")).toBe("application/octet-stream")
  })

  it("closes the async iterator when its request body is canceled", async () => {
    const { client, sent } = recorder(contract)
    let closed = false
    async function* chunks() {
      try {
        yield new Uint8Array([65])
        yield new Uint8Array([66])
      } finally {
        closed = true
      }
    }
    await client.fetch("POST /upload", {
      body: chunks(),
      headers: { "content-type": "application/octet-stream" },
    })
    const reader = sent().body?.getReader()
    try {
      expect(await reader?.read()).toMatchObject({ value: new Uint8Array([65]) })
    } finally {
      await reader?.cancel("finished")
      reader?.releaseLock()
    }
    expect(closed).toBe(true)
  })

  it("propagates async iterator failures while reading the request body", async () => {
    const { client, sent } = recorder(contract)
    const failure = new Error("Upload failed")
    async function* chunks() {
      yield new Uint8Array([65])
      throw failure
    }
    await client.fetch("POST /upload", {
      body: chunks(),
      headers: { "content-type": "application/octet-stream" },
    })
    // Native Request can replace a source error with its own transport TypeError.
    await expect(sent().arrayBuffer()).rejects.toBeInstanceOf(Error)
  })

  it.each([
    "Blob",
    "File",
    "FormData",
    "URLSearchParams",
    "ReadableStream",
    "ArrayBuffer",
    "SharedArrayBuffer",
    "Date",
  ])("does not recognize a toStringTag-only %s as a native body or value", async (tag) => {
    const { client, sent } = recorder<{
      "POST /json": ResultOperation<{ body: Record<"application/json", unknown | BodyLike> }>
    }>({
      version: 7,
      endpoints: { "POST /json": { responses: { default: { content: { "*/*": {} } } } } },
    })
    const body = { [Symbol.toStringTag]: tag, value: "kept" }
    await client.fetch("POST /json", { headers: { "content-type": "application/json" }, body })
    expect(await sent().text()).toBe('{"value":"kept"}')
  })

  it("refuses to guess an encoding", async () => {
    const { client, sent } = recorder<{
      "POST /x": ResultOperation<{ body: Record<string, string | BodyLike> }>
      "POST /t": ResultOperation<{ body: Record<string, string | BodyLike> }>
    }>({
      version: 7,
      endpoints: {
        "POST /x": {
          requestBody: { required: false, content: { "application/xml": {} } },
          responses: { default: { content: { "*/*": {} } } },
        },
        "POST /t": {
          requestBody: { required: false, content: { "text/plain": {} } },
          responses: { default: { content: { "*/*": {} } } },
        },
      },
    })
    // The client cannot encode XML, so only ready-made bodies type-check.

    await expect(
      // @ts-expect-error an object is not an XML body
      client.fetch("POST /x", {
        body: { a: "1" },
        headers: { "content-type": "application/xml" },
      }),
    ).rejects.toThrow("Cannot encode a object as application/xml")
    await client.fetch("POST /x", {
      headers: { "content-type": "application/xml" },
      body: "<a>1</a>",
    })
    expect(await sent().text()).toBe("<a>1</a>")
    await client.fetch("POST /t", { headers: { "content-type": "text/plain" }, body: "hi" })
    expect([sent().headers.get("content-type"), await sent().text()]).toStrictEqual([
      "text/plain",
      "hi",
    ])
    await expect(
      client.fetch("POST /t", { headers: { "content-type": "text/plain" }, body: 1 as never }),
    ).rejects.toThrow("Cannot encode a number as text/plain")
  })

  it("refuses a Blob wherever it would be written as text or JSON", async () => {
    const { client } = recorder<{
      "POST /m": ResultOperation<{
        query?: { q?: unknown; j?: unknown }
        body?: Record<
          "application/json" | "application/x-www-form-urlencoded" | "multipart/form-data",
          unknown | { meta?: object } | { f?: unknown; j?: unknown } | BodyLike
        >
      }>
    }>({
      version: 7,
      endpoints: {
        "POST /m": {
          parameters: {
            query: { j: { required: false, encoding: { contentType: "application/json" } } },
          },

          requestBody: {
            required: false,
            content: Object.fromEntries(
              Object.entries({
                "application/json": { j: { contentType: "application/json" } },
                "multipart/form-data": { j: { contentType: "application/json" } },
                "application/x-www-form-urlencoded": { j: { contentType: "application/json" } },
              }).map(([media, encoding]) => [media, { encoding }]),
            ),
          },
          responses: { default: { content: { "*/*": {} } } },
        },
      },
    })
    const blob = new Blob([])
    const calls = [
      [
        () =>
          client.fetch("POST /m", {
            body: { a: blob },
            headers: { "content-type": "application/json" },
          }),
        "inside JSON",
      ],
      [() => client.fetch("POST /m", { query: { q: blob } }), "as text"],
      [() => client.fetch("POST /m", { query: { j: { a: blob } } }), "inside JSON"],
      [
        () =>
          client.fetch("POST /m", {
            body: { f: blob },
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }),
        "as text",
      ],
      [
        () =>
          client.fetch("POST /m", {
            body: { j: [blob] },
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }),
        "inside JSON",
      ],
      [
        () =>
          client.fetch("POST /m", {
            body: { meta: { blob } },
            headers: { "content-type": "multipart/form-data" },
          }),
        "inside JSON",
      ],
    ] as const
    for (const [call, where] of calls) {
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      await expect(call()).rejects.toThrow(`A Blob cannot be sent ${where}`)
    }
  })

  it("rejects a branded Blob in JSON even without the local Blob prototype", async () => {
    // Node VM contexts have no Blob constructor. Retain native state while replacing the
    // prototype chain to exercise the same brand check needed for another browser realm.
    const blob = new Blob(["binary"])
    Object.setPrototypeOf(
      blob,
      Object.create(Object.prototype, Object.getOwnPropertyDescriptors(Blob.prototype)),
    )
    expect(blob).not.toBeInstanceOf(Blob)
    const { client, requests } = recorder<{
      "POST /json": ResultOperation<{ body: Record<"application/json", unknown | BodyLike> }>
    }>({
      version: 7,
      endpoints: { "POST /json": { responses: { default: { content: { "*/*": {} } } } } },
    })
    await expect(
      client.fetch("POST /json", {
        body: { nested: blob },
        headers: { "content-type": "application/json" },
      }),
    ).rejects.toThrow("A Blob cannot be sent inside JSON")
    expect(requests).toHaveLength(0)
  })
})

it("uses form encoding for a whole form query and URL encoding for ordinary parameters", async () => {
  const { client, requests } = recorder<{
    "GET /form": ResultOperation<{ query: { foo: string } | string }>
    "GET /ordinary": ResultOperation<{ query: { foo: string } }>
  }>({
    version: 7,
    endpoints: {
      "GET /form": {
        querystring: { required: false, content: { "application/x-www-form-urlencoded": {} } },
        responses: { default: { content: { "*/*": {} } } },
      },
      "GET /ordinary": { responses: { default: { content: { "*/*": {} } } } },
    },
  })
  await client.fetch("GET /form", { query: { foo: "a + b!~'()*" } })
  await client.fetch("GET /ordinary", { query: { foo: "a + b!~'()*" } })
  await client.fetch("GET /form", { query: "foo=a+b" })
  expect(requests.map((request) => url(request))).toStrictEqual([
    "/form?foo=a+%2B+b%21%7E%27%28%29*",
    "/ordinary?foo=a%20%2B%20b%21~%27%28%29%2A",
    "/form?foo=a+b",
  ])
})

it.each([false, true])(
  "acquires an upload iterator only on demand (read first: %s)",
  async (readFirst) => {
    const next = vi.fn<() => Promise<IteratorResult<Uint8Array>>>(() =>
      Promise.resolve({ done: false, value: new Uint8Array([65]) }),
    )
    const close = vi.fn<(reason?: unknown) => Promise<IteratorResult<Uint8Array>>>(() =>
      Promise.resolve({ done: true, value: undefined }),
    )
    const acquire = vi.fn<() => AsyncIterator<Uint8Array>>(() => ({ next, return: close }))
    const { client, sent } = recorder(contract)
    await client.fetch("POST /upload", {
      body: { [Symbol.asyncIterator]: acquire },
      headers: { "content-type": "application/octet-stream" },
    })
    const reader = sent().body?.getReader()
    expect(acquire).not.toHaveBeenCalled()
    const reason = { stopped: true }
    try {
      if (readFirst) await reader?.read()
      await reader?.cancel(reason)
      expect(acquire).toHaveBeenCalledTimes(readFirst ? 1 : 0)
      expect(next).toHaveBeenCalledTimes(readFirst ? 1 : 0)
      expect(close).toHaveBeenCalledTimes(readFirst ? 1 : 0)
      expect(close.mock.calls[0]?.[0]).toBe(readFirst ? reason : undefined)
    } finally {
      reader?.releaseLock()
    }
  },
)
