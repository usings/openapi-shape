import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import type { Fetcher, Middleware, MiddlewareContext } from "../src/client"
import { createClient, defineMiddleware } from "../src/client"
import type { BodyLike } from "../src/client/types"
import { contract } from "./__snapshots__/client-api"
import { recorder, shared, url } from "./helpers/client"
import type { ResultOperation } from "./helpers/contract"

// A Node.js-style stream: an async iterable of bytes.
async function* chunks(): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(new Uint8Array([1]))
}

/** What `result` reads from a response with this body, content type, and status. */
async function decoded(body: BodyInit | null, type?: string, status = 200): Promise<unknown> {
  const headers = type === undefined ? undefined : { "content-type": type }
  const { client } = recorder<{
    "GET /x": ResultOperation
  }>({ version: 5, endpoints: { "GET /x": {} } }, {}, () => new Response(body, { status, headers }))
  const { data, error } = await client.result("GET /x")
  return status < 300 ? data : error
}

/** A middleware, or a `fetch` option, that throws as it is called. */
function refuse(): never {
  throw new Error("no token")
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

  it.each([
    null,
    undefined,
    false,
    "GET /a",
    [],
    { stream: "unknown" },
    { stream: false },
    { stream: null },
    { stream: [] },
    { stream: ["sse"] },
    { stream: ["application/json-seq"] },
    { stream: ["text/event-stream", "text/event-stream"] },
    { stream: ["text/event-stream", null] },
    { stream: Array(1) },
  ])("rejects an invalid endpoint entry or unsupported stream protocol (%#)", (plan) => {
    expect(() => createClient({ version: 5, endpoints: { "GET /a": plan } } as never)).toThrow(
      TypeError,
    )
  })

  it.each(["GET", "GET ", " /a", "GET  /a", "GET\t/a", "BAD( /a"])(
    "validates method and path in endpoint keys (%s)",
    (endpoint) => {
      const given = { version: 5, endpoints: { [endpoint]: {} } } as const
      expect(() => createClient(given)).toThrow("Invalid plan for endpoint")
    },
  )

  it("requires the current contract format and directs mismatches to regeneration", () => {
    for (const given of [
      undefined,
      null,
      { endpoints: {} },
      { version: 4, endpoints: {} },
      { version: 6, endpoints: {} },
      { version: "5", endpoints: {} },
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
      const { client, requests } = recorder(contract, {
        baseURL: "https://api.test/v1/",
        headers: { "x-client": "shared" },
      })
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
        contentType: "multipart/form-data",
        body: { file: new Blob(["portrait"]) },
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
      version: 5,
      endpoints: { "customVerb /a b": {} },
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
    // Repeated names, as `new Headers()` keeps them.
    const cookies = new Headers([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ])
    await client.fetch("GET /pets", { headers: cookies })
    expect(sent().headers.getSetCookie()).toStrictEqual(["a=1", "b=2"])
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
        version: 5,
        endpoints: {
          "GET /a/{x}/{y}/{z}": {},
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
          version: 5,
          endpoints: {
            [endpoint]: {
              params: { [name]: { style: "matrix", allowReserved: true } },
            },
          },
        })
        await client.fetch(endpoint, { params: { [name]: "safe" } })
        expect(url(sent())).toBe(`/files/;${encodeURIComponent(name)}=safe/tail`)
        const exploded = recorder<
          Record<string, ResultOperation<{ params: Record<string, unknown> }>>
        >({
          version: 5,
          endpoints: {
            [endpoint]: {
              params: { [name]: { style: "matrix", explode: true } },
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
          version: 5,
          endpoints: {
            [endpoint]: {},
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
        version: 5,
        endpoints: {
          "GET /files//prefix-{a/b}-{c/d}/": {},
          "GET /files/{a/b}/tail": {
            params: { "a/b": { allowReserved: true } },
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

    it("serializes cross-realm plain objects and Dates as ordinary parameter values", async () => {
      const { client, sent } = recorder<{
        "GET /files/{meta}": ResultOperation<{
          params: { meta: object }
          query: Record<string, unknown>
        }>
      }>({
        version: 5,
        endpoints: {
          "GET /files/{meta}": {
            query: { filter: { style: "deepObject" } },
          },
        },
      })
      const input = runInNewContext(
        '({ params: { meta: { id: 1 } }, query: { filter: { items: ["x", "y"] }, when: new Date(0) }, headers: { "x-meta": { id: 1 } } })',
      ) as {
        params: { meta: object }
        query: Record<string, unknown>
        headers: Record<string, unknown>
      }
      await client.fetch("GET /files/{meta}", input)
      expect(url(sent())).toBe(
        "/files/id,1?filter[items][0]=x&filter[items][1]=y&when=1970-01-01T00%3A00%3A00.000Z",
      )
      expect(sent().headers.get("x-meta")).toBe("id,1")
    })

    it.each(["toString", "constructor", "__proto__", "id"])(
      "requires an own path parameter named %s",
      async (name) => {
        const endpoint = `GET /x/{${name}}`
        const { client, sent, requests } = recorder<
          Record<string, ResultOperation<{ params: Record<string, string> }>>
        >({
          version: 5,
          endpoints: { [endpoint]: {} },
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
        version: 5,
        endpoints: {
          "GET /q?fixed=1": {
            query: { compact: { explode: false } },
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
        version: 5,
        endpoints: {
          "GET /q": {
            query: { filter: { style: "deepObject" } },
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
        version: 5,
        endpoints: {
          "GET /q": {
            query: {
              json: { contentType: " \tApplication/Problem+JSON ; p=*" },
              wild: { contentType: "Application/*" },
              text: { contentType: "TEXT/PLAIN; charset=utf-8" },
            },
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
      version: 5,
      endpoints: {
        "GET /files/{path}": {
          params: { path: { style: "simple", explode: false, allowReserved: true } },
        },
        "GET /q": {
          query: {
            next: { style: "form", explode: true, allowReserved: true },
            ids: { style: "form", explode: false },
            sp: { style: "spaceDelimited", explode: false },
            pipe: { style: "pipeDelimited", explode: false },
            spArray: { style: "spaceDelimited", explode: false },
            pipeArray: { style: "pipeDelimited", explode: false },
          },
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
  it("sets the call's headers over the body's media type", async () => {
    const { client, sent } = recorder(contract)
    await client.fetch("PATCH /pets/{id}", {
      params: { id: 1 },
      headers: { "content-type": "application/json" },
      body: { name: "R" },
    })
    expect(sent().headers.get("content-type")).toBe("application/json")
  })

  it("distinguishes an omitted body from empty text", async () => {
    const { client, sent } = recorder<{
      "POST /text": ResultOperation<{ body?: string | BodyLike; contentType?: string }>
    }>({
      version: 5,
      endpoints: {
        "POST /text": { contentType: "text/plain" },
      },
    })
    await client.fetch("POST /text")
    expect(sent().body).toBeNull()
    expect(sent().headers.has("content-type")).toBe(false)
    await client.fetch("POST /text", { body: "" })
    expect(sent().body).not.toBeNull()
    expect(sent().headers.get("content-type")).toBe("text/plain")
    expect(await sent().text()).toBe("")
  })

  it("sends JSON by default, and other JSON media types as declared", async () => {
    const { client, sent } = recorder(contract)
    await client.fetch("POST /pets", { body: { name: "Rex" } })
    expect(sent().headers.get("content-type")).toBe("application/json")
    expect(await sent().text()).toBe('{"name":"Rex"}')
    await client.fetch("PATCH /pets/{id}", { params: { id: 1 }, body: { name: "R" } })
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
      contentType: "multipart/form-data",
      headers: { "content-type": "multipart/form-data" },
      body: form,
    })
    expect(sent().headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
    const parts = await sent().formData()
    expect(parts.get("name")).toBe("n")
    await client.fetch("POST /upload", {
      contentType: "application/octet-stream",
      body: new Uint8Array([1, 2]),
    })
    expect(sent().headers.get("content-type")).toBe("application/octet-stream")
    expect(new Uint8Array(await sent().arrayBuffer())).toStrictEqual(new Uint8Array([1, 2]))
    // fetch takes no shared memory, and some runtimes would send it as text.
    await client.fetch("POST /upload", {
      contentType: "application/octet-stream",
      body: new Uint8Array(shared([1, 2])),
    })
    expect(new Uint8Array(await sent().arrayBuffer())).toStrictEqual(new Uint8Array([1, 2]))
    for (const body of [new ReadableStream(), chunks()]) {
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      await client.fetch("POST /upload", { contentType: "application/octet-stream", body })
      // Streaming request bodies go in half duplex.
      expect((sent() as Request & { duplex?: string }).duplex).toBe("half")
    }
  })

  it.each([
    "new Uint8Array([65, 66]).buffer",
    "new Uint8Array([0, 65, 66, 0]).subarray(1, 3)",
    "new DataView(new Uint8Array([0, 65, 66, 0]).buffer, 1, 2)",
    "new Uint8Array(new SharedArrayBuffer(2)).map((_, i) => 65 + i).buffer",
    "(() => { const b = new SharedArrayBuffer(2); new Uint8Array(b).set([65,66]); return b })()",
  ])("passes cross-realm bytes through (%s)", async (expression) => {
    const { client, sent } = recorder(contract)
    const body: unknown = runInNewContext(expression)
    await client.fetch("POST /upload", {
      contentType: "application/octet-stream",
      body: body as ArrayBuffer,
    })
    expect(new Uint8Array(await sent().arrayBuffer())).toStrictEqual(new Uint8Array([65, 66]))
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
      "POST /json": ResultOperation<{ body: unknown | BodyLike; contentType?: "application/json" }>
    }>({
      version: 5,
      endpoints: { "POST /json": {} },
    })
    const body = { [Symbol.toStringTag]: tag, value: "kept" }
    await client.fetch("POST /json", { body })
    expect(await sent().text()).toBe('{"value":"kept"}')
  })

  it("refuses to guess an encoding", async () => {
    const { client, sent } = recorder<{
      "POST /x": ResultOperation<{ body: string | BodyLike; contentType?: string }>
      "POST /t": ResultOperation<{ body: string | BodyLike; contentType?: string }>
    }>({
      version: 5,
      endpoints: {
        "POST /x": { contentType: "application/xml" },
        "POST /t": { contentType: "text/plain" },
      },
    })
    // The client cannot encode XML, so only ready-made bodies type-check.
    // @ts-expect-error an object is not an XML body
    await expect(client.fetch("POST /x", { body: { a: "1" } })).rejects.toThrow(
      "Cannot encode a object as application/xml",
    )
    await client.fetch("POST /x", { body: "<a>1</a>" })
    expect(await sent().text()).toBe("<a>1</a>")
    await client.fetch("POST /t", { body: "hi" })
    expect([sent().headers.get("content-type"), await sent().text()]).toStrictEqual([
      "text/plain",
      "hi",
    ])
    await expect(client.fetch("POST /t", { body: 1 as never })).rejects.toThrow(
      "Cannot encode a number as text/plain",
    )
  })

  it("refuses a Blob wherever it would be written as text or JSON", async () => {
    const { client } = recorder<{
      "POST /m": ResultOperation<{
        query?: { q?: unknown; j?: unknown }
        body?: unknown | { meta?: object } | { f?: unknown; j?: unknown } | BodyLike
        contentType?:
          | "application/json"
          | "application/x-www-form-urlencoded"
          | "multipart/form-data"
      }>
    }>({
      version: 5,
      endpoints: {
        "POST /m": {
          query: { j: { contentType: "application/json" } },
          bodyEncodings: {
            "application/x-www-form-urlencoded": { j: { contentType: "application/json" } },
          },
        },
      },
    })
    const blob = new Blob([])
    const form = "application/x-www-form-urlencoded"
    const multipart = "multipart/form-data"
    const calls = [
      [() => client.fetch("POST /m", { body: { a: blob } }), "inside JSON"],
      [() => client.fetch("POST /m", { query: { q: blob } }), "as text"],
      [() => client.fetch("POST /m", { query: { j: { a: blob } } }), "inside JSON"],
      [() => client.fetch("POST /m", { contentType: form, body: { f: blob } }), "as text"],
      [() => client.fetch("POST /m", { contentType: form, body: { j: [blob] } }), "inside JSON"],
      [
        () => client.fetch("POST /m", { contentType: multipart, body: { meta: { blob } } }),
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
      "POST /json": ResultOperation<{ body: unknown | BodyLike; contentType?: "application/json" }>
    }>({
      version: 5,
      endpoints: { "POST /json": {} },
    })
    await expect(client.fetch("POST /json", { body: { nested: blob } })).rejects.toThrow(
      "A Blob cannot be sent inside JSON",
    )
    expect(requests).toHaveLength(0)
  })
})

describe("responses", () => {
  it("hands the request to the fetch option, called unbound, and resolves to its response", async () => {
    const answer = new Response("{}", { status: 404 })
    const client = createClient(contract, {
      baseURL: "https://api.test",
      // A browser's fetch refuses to be called on another object.
      fetch(this: unknown, request) {
        expect(this).toBeUndefined()
        expect(request.url).toBe("https://api.test/pets/1")
        return Promise.resolve(answer)
      },
    })
    expect(await client.fetch("GET /pets/{id}", { params: { id: 1 } })).toBe(answer)
  })

  it.each([
    ['{"id":1}', "application/json; charset=utf-8", { id: 1 }],
    ['{"id":1}', "application/problem+json", { id: 1 }],
    ["hello", "text/plain", "hello"],
    // An empty text body is still text.
    ["", "text/plain", ""],
    ["", "application/json", undefined],
    [" \n", "application/json", undefined],
    [null, undefined, undefined],
  ])("reads a body by its content type (%#)", async (body, type, expected) => {
    expect(await decoded(body, type)).toStrictEqual(expected)
    // A failure's error is never undefined: without a body, it is null.
    expect(await decoded(body, type, 500)).toStrictEqual(expected ?? null)
  })

  it("reads no content as undefined, and other content as a Blob", async () => {
    expect(await decoded(null, "application/json", 204)).toBeUndefined()
    expect(await decoded(null, "application/json", 205)).toBeUndefined()
    expect(await decoded(null, "application/json", 304)).toBeNull()
    // A body where none can be is still consumed, so that the connection is free.
    const { client } = recorder<{ "HEAD /x": ResultOperation }>(
      { version: 5, endpoints: { "HEAD /x": {} } },
      {},
      () => new Response("x", { status: 200, headers: { "content-type": "application/json" } }),
    )
    const { data, response } = await client.result("HEAD /x")
    expect(data).toBeUndefined()
    expect(response.bodyUsed).toBe(true)
    expect(await decoded("abc", "image/png")).toBeInstanceOf(Blob)
    expect(await decoded(new Blob(["abc"]))).toBeInstanceOf(Blob)
    // Event streams and JSON sequences are not parsed: `fetch` streams them.
    expect(await decoded("data: x\n\n", "text/event-stream")).toBe("data: x\n\n")
    expect(await decoded('{"a":1}\n', "application/jsonl")).toBeInstanceOf(Blob)
  })

  it("gives the data of a success and the error of a failure, with the status, its body read", async () => {
    let status = 200
    const { client } = recorder(
      contract,
      {},
      () =>
        new Response(status === 200 ? '{"id":1,"name":"Rex"}' : '{"message":"nope"}', {
          status,
          headers: { "content-type": "application/json" },
        }),
    )
    const found = await client.result("GET /pets/{id}", { params: { id: 1 } })
    expect(found).toMatchObject({ data: { id: 1, name: "Rex" }, error: undefined, status: 200 })
    status = 404
    const missing = await client.result("GET /pets/{id}", { params: { id: 1 } })
    expect(missing).toMatchObject({ data: undefined, error: { message: "nope" }, status: 404 })
    // The body is read, so the connection is free again.
    expect(missing.response.bodyUsed).toBe(true)
  })

  it("rejects a body that does not decode, as a network failure does", async () => {
    const { client } = recorder(
      contract,
      {},
      () =>
        new Response("<html>", { status: 502, headers: { "content-type": "application/json" } }),
    )
    await expect(client.result("GET /pets")).rejects.toThrow(
      "The 502 response is not the JSON it says",
    )
  })
})

describe("middleware", () => {
  it("snapshots the chain and isolates contexts across concurrent client methods", async () => {
    const ready = Promise.withResolvers<void>()
    const seen: MiddlewareContext[] = []
    const observe: Middleware = async (request, next, context) => {
      const received = await next(request)
      expect(Object.isFrozen(context)).toBe(true)
      seen.push(context)
      return received
    }
    const middleware = [observe]
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware,
      fetch: async (request) => {
        await ready.promise
        return request.url.endsWith("/events")
          ? new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } })
          : Response.json({ id: 1, name: "Milo" })
      },
    })
    middleware[0] = () => Promise.reject(new Error("changed configuration"))
    const fetched = api.fetch("GET /pets/{id}", { params: { id: 1 } })
    const result = api.result("GET /pets/{id}", { params: { id: 2 } })
    const reader = api.stream("GET /events", { retry: false }).getReader()
    const reading = reader.read()
    ready.resolve()
    await Promise.all([fetched, result, reading])
    expect(seen.toSorted((a, b) => a.kind.localeCompare(b.kind))).toStrictEqual([
      { endpoint: "GET /pets/{id}", kind: "fetch" },
      { endpoint: "GET /pets/{id}", kind: "result" },
      { endpoint: "GET /events", kind: "stream" },
    ])
    const fetchedResponse = await fetched
    await fetchedResponse.body?.cancel()
    await reader.cancel()
  })

  it.each(["fetch", "result"] as const)(
    "cleans an undelivered response and preserves a middleware error in %s",
    async (kind) => {
      const failure = new Error("after response")
      const cancel = vi.fn<() => void>()
      const api = createClient(contract, {
        baseURL: "https://api.test",
        middleware: [
          async (request, next) => {
            await next(request)
            throw failure
          },
        ],
        fetch: () => Promise.resolve(new Response(new ReadableStream({ cancel }))),
      })
      await expect(api[kind]("GET /pets")).rejects.toBe(failure)
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(["fetch", "result"] as const)(
    "retires transport and intermediate middleware responses before handing off %s",
    async (kind) => {
      const transportCancel = vi.fn<() => void>()
      const middleCancel = vi.fn<() => void>()
      const selected = Response.json({ id: 1, name: "Milo" })
      const api = createClient(contract, {
        baseURL: "https://api.test",
        middleware: [
          async (request, next) => {
            await next(request)
            return selected
          },
          async (request, next) => {
            await next(request)
            return new Response(new ReadableStream({ cancel: middleCancel }))
          },
        ],
        fetch: () => Promise.resolve(new Response(new ReadableStream({ cancel: transportCancel }))),
      })
      const answer = await api[kind]("GET /pets/{id}", { params: { id: 1 } })
      expect(transportCancel).toHaveBeenCalledOnce()
      expect(middleCancel).toHaveBeenCalledOnce()
      const data = answer instanceof Response ? await answer.json() : answer.data
      expect(data).toStrictEqual({ id: 1, name: "Milo" })
    },
  )

  it("keeps a selected response body alive when middleware wraps the same stream", async () => {
    const original = new Response('"kept"', { headers: { "content-type": "application/json" } })
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware: [
        async (request, next) => {
          const received = await next(request)
          return new Response(received.body)
        },
      ],
      fetch: () => Promise.resolve(original),
    })
    const selected = await api.fetch("GET /pets")
    expect(selected.body).toBe(original.body)
    expect(await selected.json()).toBe("kept")
  })

  it("cancels a late next response without canceling the selected response", async () => {
    const pending = Promise.withResolvers<Response>()
    const cancel = vi.fn<() => void>()
    let late: Promise<Response> | undefined
    let attempts = 0
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware: [
        (request, next) => {
          const selected = next(request.clone())
          late = next(request)
          return selected
        },
      ],
      fetch: () =>
        ++attempts === 1 ? Promise.resolve(Response.json("selected")) : pending.promise,
    })
    const selected = await api.fetch("GET /pets")
    pending.resolve(new Response(new ReadableStream({ cancel })))
    await late
    expect(cancel).toHaveBeenCalledOnce()
    expect(await selected.json()).toBe("selected")
  })

  it.each(["fetch", "result"] as const)(
    "aborts pending %s middleware and retires its late transport response",
    async (kind) => {
      const pending = Promise.withResolvers<Response>()
      const started = Promise.withResolvers<void>()
      const canceled = Promise.withResolvers<void>()
      const abort = new AbortController()
      const failure = { reason: "stop" }
      const api = createClient(contract, {
        baseURL: "https://api.test",
        fetch: () => {
          started.resolve()
          return pending.promise
        },
      })
      const result = api[kind]("GET /pets", { signal: abort.signal }).catch(
        (error: unknown) => error,
      )
      await started.promise
      abort.abort(failure)
      expect(await result).toBe(failure)
      pending.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              canceled.resolve()
            },
          }),
        ),
      )
      await canceled.promise
    },
  )

  it("blocks a retained next after cancellation even if its request replaces the signal", async () => {
    const fetch = vi.fn<Fetcher>()
    const abort = new AbortController()
    let resume: Fetcher | undefined
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware: [
        (_request, next) => {
          resume = next
          return Promise.resolve(Response.json([]))
        },
      ],
      fetch,
    })
    const selected = await api.fetch("GET /pets", { signal: abort.signal })
    const failure = new Error("finished")
    abort.abort(failure)
    await expect(resume?.(new Request("https://api.test/pets"))).rejects.toBe(failure)
    expect(fetch).not.toHaveBeenCalled()
    await selected.body?.cancel()
  })

  it("leaves result decoding outside the HTTP middleware error boundary", async () => {
    const caught = vi.fn<() => void>()
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware: [
        async (request, next) => {
          try {
            return await next(request)
          } catch (error) {
            caught()
            throw error
          }
        },
      ],
      fetch: () =>
        Promise.resolve(new Response("{bad}", { headers: { "content-type": "application/json" } })),
    })
    await expect(api.result("GET /pets")).rejects.toBeInstanceOf(SyntaxError)
    expect(caught).not.toHaveBeenCalled()
  })

  it("wraps sending, the first outermost, with the fetch option after the last", async () => {
    const answered: string[] = []
    const via = (name: string): Middleware =>
      defineMiddleware(async (request, next) => {
        request.headers.append("x-via", name)
        const response = await next(request)
        answered.push(name)
        return response
      })
    const { client, sent } = recorder(contract, { middleware: [via("outer"), via("inner")] })
    await client.fetch("GET /pets")
    expect(sent().headers.get("x-via")).toBe("outer, inner")
    expect(answered).toStrictEqual(["inner", "outer"])
  })

  it("sends what a middleware passes on, and again each time it calls next", async () => {
    let tries = 0
    const passed: string[] = []
    const { client, requests } = recorder(
      contract,
      {
        middleware: [
          // A retry: the second try sends the request the first one did not use up.
          async (request, next) => {
            const first = await next(request.clone())
            if (first.status !== 503) return first
            await first.body?.cancel()
            return next(request)
          },
          (request, next) => {
            passed.push(request.method)
            return next(new Request(request, { headers: { "x-try": String(passed.length) } }))
          },
        ],
      },
      () => new Response(null, { status: ++tries === 1 ? 503 : 204 }),
    )
    const response = await client.fetch("GET /pets")
    expect(response.status).toBe(204)
    expect(passed).toStrictEqual(["GET", "GET"])
    expect(requests.map((request) => request.headers.get("x-try"))).toStrictEqual(["1", "2"])
  })

  it("reads the body of the response the middleware pass on", async () => {
    const seen: unknown[] = []
    const { client } = recorder(
      contract,
      {
        middleware: [
          async (request, next) => {
            const response = await next(request)
            seen.push(await response.clone().json())
            return response
          },
        ],
      },
      () => Response.json({ id: 1, name: "Rex" }),
    )
    const { data } = await client.result("GET /pets/{id}", { params: { id: 1 } })
    expect(data).toStrictEqual({ id: 1, name: "Rex" })
    expect(seen).toStrictEqual([data])
  })

  it("takes a middleware's own answer, sending nothing", async () => {
    const { client, requests } = recorder(contract, {
      middleware: [() => Promise.resolve(Response.json({ id: 1, name: "Rex" }))],
    })
    const { data } = await client.result("GET /pets/{id}", { params: { id: 1 } })
    expect(data).toStrictEqual({ id: 1, name: "Rex" })
    expect(requests).toStrictEqual([])
  })

  it("rejects what a middleware throws", async () => {
    const { client } = recorder(contract, { middleware: [refuse] })
    await expect(client.fetch("GET /pets")).rejects.toThrow("no token")
    await expect(client.result("GET /pets")).rejects.toThrow("no token")
  })

  it("rejects next, never throws from it, whatever throws inside", async () => {
    const fallback = defineMiddleware((request, next) =>
      next(request).catch(() => new Response(null, { status: 503 })),
    )
    for (const options of [
      { middleware: [fallback, refuse] },
      { middleware: [fallback], fetch: refuse },
    ]) {
      const client = createClient(contract, { baseURL: "https://x.test", ...options })
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      const response = await client.fetch("GET /pets")
      expect(response.status).toBe(503)
    }
  })
})
