import { describe, expect, it } from "vitest"
import type { Client, ClientOptions, Contract } from "../src/client"
import { createClient } from "../src/client"
import { contract } from "./__snapshots__/client-api"

/**
 * A client whose `fetch` records each request and answers with `respond()`;
 * `sent()` is the last request. Endpoint paths go under `https://x.test`.
 */
function recorder<Api>(
  given: Contract<Api>,
  options: ClientOptions = {},
  respond: () => Response = () => new Response(null, { status: 204 }),
): { client: Client<Api>; sent: () => Request; requests: Request[] } {
  const requests: Request[] = []
  const client = createClient(given, {
    baseUrl: "https://x.test",
    ...options,
    fetch: (request) => {
      requests.push(request)
      return Promise.resolve(respond())
    },
  })
  const sent = (): Request => {
    const last = requests.at(-1)
    if (last === undefined) throw new Error("Nothing was sent")
    return last
  }
  return { client, sent, requests }
}

/** A request's URL under `https://x.test`. */
function url(request: Request): string {
  return request.url.slice("https://x.test".length)
}

/** What `result` reads from a response with this body, content type, and status. */
async function decoded(body: BodyInit | null, type?: string, status = 200): Promise<unknown> {
  const headers = type === undefined ? undefined : { "content-type": type }
  const { client } = recorder<{
    "GET /x": { responses: object }
  }>({ version: 1, endpoints: {} }, {}, () => new Response(body, { status, headers }))
  const { data, error } = await client.result("GET /x")
  return status < 300 ? data : error
}

/** A `SharedArrayBuffer` holding these bytes. */
function shared(values: number[]): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(values.length)
  new Uint8Array(buffer).set(values)
  return buffer
}

// A Node.js-style stream: an async iterable of bytes.
async function* chunks(): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(new Uint8Array([1]))
}

describe("createClient", () => {
  it("refuses a base URL that would swallow the path", () => {
    expect(() => createClient(contract, { baseUrl: "https://api.test/v1?k=1" })).toThrow(
      "has a query or fragment",
    )
    expect(() => createClient(contract, { baseUrl: new URL("https://api.test/v1#top") })).toThrow(
      "has a query or fragment",
    )
  })

  it("requires a contract of the supported format", () => {
    for (const given of [undefined, { endpoints: {} }, { version: 2, endpoints: {} }]) {
      expect(() => createClient(given as never)).toThrow(
        "createClient takes a generated contract of format 1 as its first argument",
      )
    }
  })
})

describe("building requests", () => {
  it("expands path parameters with simple style under the base URL", async () => {
    const { client, sent } = recorder(contract, { baseUrl: "https://api.test/v1/" })
    await client.fetch("GET /pets/{id}", { params: { id: 7 } })
    expect([sent().method, sent().url]).toStrictEqual(["GET", "https://api.test/v1/pets/7"])
  })

  it("encodes path parameter values, arrays, and objects", async () => {
    const { client, sent } = recorder<{
      "GET /a/{x}/{y}/{z}": { params: { x: string; y: string[]; z: object }; responses: object }
    }>({ version: 1, endpoints: {} })
    await client.fetch("GET /a/{x}/{y}/{z}", {
      params: { x: "雪/a b", y: ["1", "2"], z: { k: "v w" } },
    })
    expect(url(sent())).toBe("/a/%E9%9B%AA%2Fa%20b/1,2/k,v%20w")
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

  it("serializes the query with form style, exploding arrays and objects", async () => {
    const { client, sent } = recorder<{
      "GET /q?fixed=1": { query: Record<string, unknown>; responses: object }
    }>({ version: 1, endpoints: { "GET /q?fixed=1": { query: { compact: { explode: false } } } } })
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
      "GET /q": { query: Record<string, unknown>; responses: object }
    }>({ version: 1, endpoints: { "GET /q": { query: { filter: { style: "deepObject" } } } } })
    const items = Object.assign(Array<string | undefined>(4), {
      forEach: () => {
        throw new Error("Do not call a method on the input")
      },
    })
    items[2] = "a/b &+"
    const filter = Object.assign(Object.create(null), { items, omit: null, empty: {}, flag: false })
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
      "GET /q": { query: Record<string, unknown>; responses: object }
    }>({
      version: 1,
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

  it("sets the call's headers over the body's media type", async () => {
    const { client, sent } = recorder(contract)
    await client.fetch("PATCH /pets/{id}", {
      params: { id: 1 },
      headers: { "content-type": "application/json" },
      body: { name: "R" },
    })
    expect(sent().headers.get("content-type")).toBe("application/json")
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

describe("request bodies", () => {
  it("distinguishes an omitted body from empty text", async () => {
    const { client, sent } = recorder<{
      "POST /text": { body?: { "text/plain": string }; responses: object }
    }>({ version: 1, endpoints: { "POST /text": { contentType: "text/plain" } } })
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

  it("encodes form bodies, fields as their Encoding Objects say", async () => {
    const { client, sent } = recorder(contract)
    await client.fetch("POST /token", { body: { grant_type: "client credentials" } })
    expect(sent().headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(await sent().text()).toBe("grant_type=client%20credentials")
    const body = { amount: 100, metadata: { order: "7" }, tags: ["a", "b"], filter: { live: true } }
    await client.fetch("POST /charges", { body })
    expect(await sent().text()).toBe(
      "amount=100&metadata[order]=7&tags[0]=a&tags[1]=b&filter=%7B%22live%22%3Atrue%7D",
    )
  })

  it("encodes multipart bodies as FormData", async () => {
    const { client, sent } = recorder<{
      "POST /m": { body: { "multipart/form-data": Record<string, unknown> }; responses: object }
    }>({ version: 1, endpoints: { "POST /m": { contentType: "multipart/form-data" } } })
    const body = {
      photo: new File(["PNG"], "photo.png", { type: "image/png" }),
      raw: new Blob(["x"]),
      meta: { a: 1 },
      tags: ["x", "y"],
      when: new Date(0),
      bytes: new Uint8Array([1, 2]),
      shared: shared([3]),
      sharedView: new Uint8Array(shared([4])),
      skipped: undefined,
    }
    await client.fetch("POST /m", { body })
    expect(sent().headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
    const form = await sent().formData()
    expect(form.get("photo")).toMatchObject({ name: "photo.png", type: "image/png" })
    // A Blob without a name is still a file.
    expect(form.get("raw")).toMatchObject({ name: "blob" })
    expect(form.get("meta")).toBe('{"a":1}')
    expect(form.getAll("tags")).toStrictEqual(["x", "y"])
    expect(form.get("when")).toBe("1970-01-01T00:00:00.000Z")
    // Buffers are bytes, so files, too, also in shared memory.
    const files = await Promise.all(
      ["bytes", "shared", "sharedView"].map((name) => (form.get(name) as Blob).arrayBuffer()),
    )
    expect(files.map((buffer) => new Uint8Array(buffer))).toStrictEqual(
      [[1, 2], [3], [4]].map((values) => new Uint8Array(values)),
    )
    expect(form.has("skipped")).toBe(false)
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

  it("refuses to guess an encoding", async () => {
    const { client, sent } = recorder<{
      "POST /x": { body: { "application/xml": { a: string } }; responses: object }
      "POST /t": { body: { "text/plain": string }; responses: object }
    }>({
      version: 1,
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
      "POST /m": {
        query: { q?: unknown; j?: unknown }
        body?: {
          "application/json": unknown
          "multipart/form-data": { meta?: object }
          "application/x-www-form-urlencoded": { f?: unknown; j?: unknown }
        }
        responses: object
      }
    }>({
      version: 1,
      endpoints: {
        "POST /m": {
          query: { j: { contentType: "application/json" } },
          encoding: { j: { contentType: "application/json" } },
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
})

describe("reserved characters, delimiters, and path segments", () => {
  const { client, sent } = recorder<{
    "GET /files/{path}": { params: { path: string }; responses: object }
    "GET /q": { query: Record<string, unknown>; responses: object }
  }>({
    version: 1,
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

describe("responses", () => {
  it("hands the request to the fetch option, called unbound, and resolves to its response", async () => {
    const answer = new Response("{}", { status: 404 })
    const client = createClient(contract, {
      baseUrl: "https://api.test",
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
    const { client } = recorder<{ "HEAD /x": { responses: object } }>(
      { version: 1, endpoints: {} },
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
