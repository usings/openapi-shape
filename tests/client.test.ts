import { describe, expect, expectTypeOf, it } from "vitest"
import type { AdapterRequest, Client, Contract, ErrorOf, SuccessOf } from "../src/client"
import { HttpError, createClient, fetchAdapter } from "../src/client"
import type { Endpoints, Schemas, Security } from "./__snapshots__/client-api"
import { contract } from "./__snapshots__/client-api"

/** A client for the generated fixture contract whose adapter records requests. */
function recording(
  config: {
    server?: string
    headers?: Record<string, string>
    options?: Record<string, number>
    security?: Parameters<typeof createClient<Endpoints, Security>>[0]["security"]
  } = {},
) {
  const requests: AdapterRequest[] = []
  const api = createClient({
    contract,
    ...config,
    adapter: (request: AdapterRequest<Record<string, number>>) => {
      requests.push(request)
      return Promise.resolve()
    },
  })
  return { api, requests }
}

/** A multipart request body, read back as a server's parser reads it. */
function parts(request: AdapterRequest): Promise<FormData> {
  const type = request.headers["content-type"] ?? ""
  return new Response(request.body as Blob, { headers: { "content-type": type } }).formData()
}

/** One part of a multipart body as written: its name, extra headers, and content. */
function part(name: string, headers: string, content: string): string {
  return `Content-Disposition: form-data; name="${name}"\r\n${headers}\r\n${content}\r\n`
}

/** What `fetchAdapter` decodes from a 200 response with this body and content type. */
function decode(body: BodyInit | null, type?: string): Promise<unknown> {
  const init = type === undefined ? {} : { headers: { "content-type": type } }
  return fetchAdapter(respond(body, init) as typeof fetch)({
    method: "GET",
    url: "/x",
    headers: {},
    body: undefined,
    options: undefined,
  })
}

/** A contract for hand-written endpoint types, with OpenAPI's defaults throughout. */
function contractFor<Api>(endpoints: Contract<Api>["endpoints"] = {}): Contract<Api> {
  return { servers: [], endpoints }
}

/** An adapter that answers with what it was asked to send. */
const echo =
  <K extends keyof AdapterRequest>(key: K) =>
  (request: AdapterRequest): Promise<unknown> =>
    Promise.resolve(request[key])

describe("request building", () => {
  it("expands path parameters with simple style and joins the server", async () => {
    const { api, requests } = recording({ server: "https://api.test/v1/" })
    await api("GET /pets/{id}", { params: { id: 7 } })
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://api.test/v1/pets/7",
      body: undefined,
    })
  })

  it("encodes path parameter values, arrays, and objects", async () => {
    const api = createClient({
      contract: contractFor<{
        "GET /a/{x}/{y}/{z}": {
          params: { x: string; y: string[]; z: object }
          response: Record<never, never>
        }
      }>(),
      adapter: echo("url"),
    })
    expect(
      await api("GET /a/{x}/{y}/{z}", { params: { x: "a/b c", y: ["1", "2"], z: { k: "v w" } } }),
    ).toBe("/a/a%2Fb%20c/1,2/k,v%20w")
    await expect(api("GET /a/{x}/{y}/{z}", { params: {} as never })).rejects.toThrow(
      'Missing path parameter "x"',
    )
  })

  it("serializes the query with form style, exploding arrays and objects", async () => {
    const api = createClient({
      contract: contractFor<{
        "GET /q?fixed=1": { query: Record<string, unknown>; response: Record<never, never> }
      }>(),
      adapter: echo("url"),
    })
    expect(
      await api("GET /q?fixed=1", {
        query: { a: [1, 2], b: null, c: { d: true, e: "x y" }, f: "" },
      }),
    ).toBe("/q?fixed=1&a=1&a=2&d=true&e=x%20y&f=")
  })

  it("merges headers case-insensitively and serializes declared header and cookie values", async () => {
    const { api, requests } = recording({
      headers: { "Authorization": "Bearer t", "X-Trace": "default" },
    })
    // No credentials are configured, so the header given stays.
    await api("GET /pets/{id}", {
      params: { id: 1 },
      headers: { "X-Trace": "call", "x-list": ["a", "b"] },
      cookies: { session: "a b;c" },
    })
    expect(requests[0].headers).toStrictEqual({
      "authorization": "Bearer t",
      "x-trace": "call",
      "x-list": "a,b",
      "cookie": "session=a%20b%3Bc",
    })
  })

  it("shallow-merges adapter options", async () => {
    const { api, requests } = recording({ options: { a: 1, b: 1 } })
    await api("DELETE /pets/{id}", { params: { id: 1 }, options: { b: 2 } })
    expect(requests[0].options).toStrictEqual({ a: 1, b: 2 })
  })
})

describe("request bodies", () => {
  it("sends JSON by default", async () => {
    const { api, requests } = recording()
    await api("POST /pets", { body: { name: "Rex" } })
    expect(requests[0]).toMatchObject({
      body: '{"name":"Rex"}',
      headers: { "content-type": "application/json" },
    })
  })

  it("labels other JSON media types as declared", async () => {
    const { api, requests } = recording()
    await api("PATCH /pets/{id}", {
      params: { id: 1 },
      contentType: "application/merge-patch+json",
      body: { name: "R" },
    })
    expect(requests[0]).toMatchObject({
      body: '{"name":"R"}',
      headers: { "content-type": "application/merge-patch+json" },
    })
  })

  it("encodes form and multipart bodies", async () => {
    const { api, requests } = recording()
    // The only declared media type is the default.
    await api("POST /token", { body: { grant_type: "client credentials" } })
    expect(requests[0].body).toBe("grant_type=client%20credentials")
    expect(requests[0].headers).toStrictEqual({
      "content-type": "application/x-www-form-urlencoded",
    })

    const file = new Blob(["data"], { type: "text/plain" })
    await api("POST /upload", { contentType: "multipart/form-data", body: { file, name: "n" } })
    const form = await parts(requests[1])
    expect(form.get("name")).toBe("n")
    expect(form.get("file")).toBeInstanceOf(Blob)
    expect(requests[1].headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/)
  })

  it("labels declared multipart parts without making them files", async () => {
    let sent: AdapterRequest | undefined
    const api = createClient({
      contract: contractFor<{
        "POST /m": {
          body: {
            "multipart/form-data": {
              "meta": object
              "raw": object
              "data": object
              "note": string
              "csv": string
              "tags": string[]
              'say "hi"': string
            }
          }
          response: Record<never, never>
        }
      }>({
        "POST /m": {
          contentType: "multipart/form-data",
          encoding: {
            "multipart/form-data": {
              raw: { contentType: "text/plain" },
              data: { contentType: "application/json" },
              note: { contentType: "text/markdown" },
              csv: { contentType: "text/csv; charset=iso-8859-1" },
            },
          },
        },
      }),
      adapter: (request) => {
        sent = request
        return Promise.resolve()
      },
    })
    const body = {
      "meta": { a: 1 },
      "raw": { c: 3 },
      "data": { b: 2 },
      "note": "# hi",
      "csv": "café",
      "tags": ["x", "y"],
      'say "hi"': "line\nbreak",
    }
    await api("POST /m", { body })
    const request = sent as AdapterRequest
    const text = await (request.body as Blob).text()
    // Undeclared, an object is a JSON part, as OpenAPI defaults.
    expect(text).toContain(part("meta", "Content-Type: application/json\r\n", '{"a":1}'))
    // Declared text/plain, it is a plain field, as some servers need.
    expect(text).toContain(part("raw", "", '{"c":3}'))
    expect(text).toContain(part("data", "Content-Type: application/json\r\n", '{"b":2}'))
    expect(text).toContain(part("note", "Content-Type: text/markdown\r\n", "# hi"))
    // Text goes as UTF-8, and says so.
    expect(text).toContain(part("csv", "Content-Type: text/csv; charset=utf-8\r\n", "café"))
    expect(text).toContain(part("say %22hi%22", "", "line\nbreak"))
    expect(text).not.toContain("filename")
    // What a server's multipart parser reads back.
    const form = await parts(request)
    expect(form.get("meta")).toBe('{"a":1}')
    expect(form.getAll("tags")).toStrictEqual(["x", "y"])
    expect(form.get('say "hi"')).toBe("line\nbreak")
  })

  it("labels a file part with its declared media type, keeping a File's name", async () => {
    let sent: AdapterRequest | undefined
    const api = createClient({
      contract: contractFor<{
        "POST /a": {
          body: { "multipart/form-data": { image: Blob; other?: Blob } }
          response: Record<never, never>
        }
      }>({
        "POST /a": {
          contentType: "multipart/form-data",
          encoding: { "multipart/form-data": { image: { contentType: "image/png" } } },
        },
      }),
      adapter: (request) => {
        sent = request
        return Promise.resolve()
      },
    })
    const file = new File(["PNG"], "photo.png", { type: "application/octet-stream" })
    await api("POST /a", { body: { image: file, other: new File(["x"], "") } })
    const form = await parts(sent as AdapterRequest)
    expect(form.get("image")).toMatchObject({ name: "photo.png", type: "image/png" })
    // A file without a name is still a file.
    expect(form.get("other")).toMatchObject({ name: "blob", type: "application/octet-stream" })
  })

  it("passes binary bodies through, labelled with the declared type", async () => {
    const { api, requests } = recording()
    const bytes = new Uint8Array([1, 2])
    await api("POST /upload", { contentType: "application/octet-stream", body: bytes as never })
    expect(requests[0]).toMatchObject({
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    })
  })

  it("refuses to guess an encoding", async () => {
    const xml = contractFor<{
      "POST /x": { body: { "application/xml": { a: string } }; response: Record<never, never> }
    }>({ "POST /x": { contentType: "application/xml" } })
    const api = createClient({ contract: xml, adapter: () => Promise.resolve() })
    const custom = createClient({ contract: xml, adapter: echo("body") })
    // The client cannot encode XML, so only ready-made bodies type-check.
    // @ts-expect-error an object is not an XML body
    const call = api("POST /x", { contentType: "application/xml", body: { a: "1" } })
    await expect(call).rejects.toThrow("Cannot encode a object as application/xml")
    expect(await custom("POST /x", { contentType: "application/xml", body: "<a>1</a>" })).toBe(
      "<a>1</a>",
    )
  })
})

// A Node.js-style stream: an async iterable of bytes.
async function* chunks(): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(new Uint8Array([1]))
}

/** A `fetch` stand-in that always answers with this response. */
const respond =
  (body: BodyInit | null, init: ResponseInit) =>
  (..._args: unknown[]): Promise<Response> =>
    Promise.resolve(new Response(body, init))

describe("with the generated contract", () => {
  it("refuses the old baseUrl option, also in a config built beforehand", () => {
    const config = { contract, baseUrl: "http://localhost:3000" }
    // @ts-expect-error renamed to server
    expect(() => createClient(config)).toThrow("The baseUrl option is now called server")
  })

  it("uses the document's server, an endpoint's own server, or the server option over both", async () => {
    const { api, requests } = recording()
    await api("GET /pets")
    await api("GET /files/{names}", { params: { names: ["a", "b"] } })
    expect(requests.map((r) => r.url)).toStrictEqual([
      "https://eu.api.test/v1/pets",
      "https://files.api.test/files/.a,b",
    ])
    const local = recording({ server: "http://localhost:3000" })
    await local.api("GET /files/{names}", { params: { names: ["a"] } })
    expect(local.requests[0].url).toBe("http://localhost:3000/files/.a")
  })

  it("serializes parameters in their declared styles", async () => {
    const { api, requests } = recording()
    await api("GET /charges", {
      query: { created: { gte: 1 }, expand: ["customer", "invoice"], ids: ["x", "y"] },
    })
    expect(requests[0].url).toBe(
      "https://eu.api.test/v1/charges?created[gte]=1&expand[0]=customer&expand[1]=invoice&ids=x%7Cy",
    )
    await api("GET /files/{names}", {
      params: { names: ["a"] },
      headers: { "X-Range": { from: 5 } },
    })
    expect(requests[1].headers["x-range"]).toBe("from=5")
  })

  it("sends the operation's declared media type, encoding form fields as declared", async () => {
    const { api, requests } = recording({ security: { basic: { username: "u", password: "p" } } })
    await api("POST /charges", {
      body: { amount: 100, metadata: { order: "7" }, tags: ["a", "b"], filter: { live: true } },
    })
    expect(requests[0]).toMatchObject({
      body: "amount=100&metadata[order]=7&tags[0]=a&tags[1]=b&filter=%7B%22live%22%3Atrue%7D",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
  })

  it("applies credentials where each operation's security requires them", async () => {
    let calls = 0
    const { api, requests } = recording({
      security: {
        bearer: () => Promise.resolve(`token-${++calls}`),
        key: "k-1",
        basic: { username: "user", password: "pässword" },
      },
    })
    await api("GET /pets")
    await api("GET /pets")
    await api("GET /charges")
    await api("GET /health")
    await api("POST /charges", { body: { amount: 1 } })
    expect(requests.map((r) => r.headers.authorization)).toStrictEqual([
      "Bearer token-1",
      "Bearer token-2",
      undefined,
      undefined,
      `Basic ${Buffer.from("user:pässword").toString("base64")}`,
    ])
    expect(requests[2].url).toBe("https://eu.api.test/v1/charges?api_key=k-1")
  })

  it("sends no credentials it was not given", async () => {
    const { api, requests } = recording({ security: { key: "k" } })
    await api("GET /pets")
    expect(requests[0].headers.authorization).toBeUndefined()
  })
})

describe("encodings", () => {
  it("serializes dates as ISO strings and JSON sequences as lines", async () => {
    interface Api {
      "POST /log": {
        query: { since: Date }
        body: { "application/x-ndjson": Array<{ n: number }> }
        response: Record<never, never>
      }
    }
    const requests: AdapterRequest[] = []
    const api = createClient({
      contract: contractFor<Api>({ "POST /log": { contentType: "application/x-ndjson" } }),
      adapter: (request) => {
        requests.push(request)
        return Promise.resolve()
      },
    })
    await api("POST /log", {
      query: { since: new Date(Date.UTC(2026, 0, 2)) },
      body: [{ n: 1 }, { n: 2 }],
    })
    expect(requests[0]).toMatchObject({
      url: "/log?since=2026-01-02T00%3A00%3A00.000Z",
      body: '{"n":1}\n{"n":2}\n',
      headers: { "content-type": "application/x-ndjson" },
    })
  })
})

describe("fetchAdapter", () => {
  it.each([
    [
      respond('{"id":1}', { headers: { "content-type": "application/json; charset=utf-8" } }),
      { id: 1 },
    ],
    [respond("hello", { headers: { "content-type": "text/plain" } }), "hello"],
    [respond(null, { status: 204 }), undefined],
    [respond("", { headers: { "content-type": "application/json" } }), undefined],
    [respond(null, {}), undefined],
    // An empty text body is still text.
    [respond("", { headers: { "content-type": "text/plain" } }), ""],
  ])("decodes responses (%#)", async (fetchImpl, expected) => {
    const adapter = fetchAdapter(fetchImpl as typeof fetch)
    expect(
      await adapter({ method: "GET", url: "/x", headers: {}, body: undefined, options: undefined }),
    ).toStrictEqual(expected)
  })

  it("decodes JSON sequences and server-sent events into arrays", async () => {
    expect(await decode('{"a":1}\n\n{"a":2}\n', "application/jsonl")).toStrictEqual([
      { a: 1 },
      { a: 2 },
    ])
    const rs = String.fromCharCode(0x1e)
    expect(await decode(`${rs}1\n${rs}2\n`, "application/json-seq")).toStrictEqual([1, 2])
    expect(
      await decode(
        ": comment\nevent: tick\ndata: a\ndata: b\nid: 7\n\ndata: c\nretry: 10\n\n",
        "text/event-stream",
      ),
    ).toStrictEqual([
      { data: "a\nb", event: "tick", id: "7" },
      { data: "c", retry: 10 },
    ])
  })

  it("keeps an undecodable error body as text", async () => {
    const adapter = fetchAdapter(
      respond("<html>oops</html>", {
        status: 500,
        headers: { "content-type": "application/json" },
      }) as typeof fetch,
    )
    const failure: unknown = await adapter({
      method: "GET",
      url: "/x",
      headers: {},
      body: undefined,
      options: undefined,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HttpError)
    expect(failure).toMatchObject({ status: 500, body: "<html>oops</html>" })
  })

  it("returns other content as a Blob", async () => {
    const adapter = fetchAdapter(
      respond("abc", { headers: { "content-type": "image/png" } }) as typeof fetch,
    )
    const blob = await adapter({
      method: "GET",
      url: "/x",
      headers: {},
      body: undefined,
      options: undefined,
    })
    expect(blob).toBeInstanceOf(Blob)
  })

  it("rejects non-2xx responses with HttpError carrying the decoded body", async () => {
    const adapter = fetchAdapter(
      respond('{"message":"nope"}', {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" },
      }) as typeof fetch,
    )
    const failure: unknown = await adapter({
      method: "GET",
      url: "/x",
      headers: {},
      body: undefined,
      options: undefined,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HttpError)
    expect(failure).toMatchObject({
      status: 404,
      body: { message: "nope" },
      message: "HTTP 404 Not Found",
    })
  })

  it("forwards the request and options to fetch", async () => {
    let seen: [unknown, RequestInit | undefined] | undefined
    const api = createClient({
      contract,
      adapter: fetchAdapter((url, init) => {
        seen = [url, init]
        return Promise.resolve(new Response(null, { status: 204 }))
      }),
      options: { cache: "no-store" },
    })
    await api("DELETE /pets/{id}", { params: { id: 3 }, options: { keepalive: true } })
    expect(seen).toStrictEqual([
      "https://eu.api.test/v1/pets/3",
      { cache: "no-store", keepalive: true, method: "DELETE", headers: {}, body: undefined },
    ])
  })
})

/** Compile-time checks: what the client infers from what it is given. Never called. */
function inferenceChecks(api: Client<Endpoints>): void {
  // @ts-expect-error unknown endpoint
  void api("GET /nope")
  void createClient({
    contract,
    security: { bearer: "t", basic: { username: "u", password: "p" } },
  })
  // @ts-expect-error credentials are checked against the declared schemes
  void createClient({ contract, security: { nope: "t" } })
  // @ts-expect-error basic credentials need a username and password
  void createClient({ contract, security: { basic: "t" } })
  const custom = createClient({
    contract,
    adapter: (_request: AdapterRequest<{ retries: number }>) => Promise.resolve(),
  })
  void custom("GET /pets", { options: { retries: 2 } })
  // @ts-expect-error options are the adapter's
  void custom("GET /pets", { options: { cache: "no-store" } })
}

/** Compile-time checks: a call must give what the operation requires. Never called. */
function requirementChecks(api: Client<Endpoints>): void {
  void api("GET /pets")
  void api("GET /pets", { query: { limit: 1 } })
  // @ts-expect-error path parameters are required
  void api("GET /pets/{id}")
  // @ts-expect-error parameter types are checked
  void api("GET /pets/{id}", { params: { id: "1" } })
  // @ts-expect-error a required query parameter
  void api("GET /search", { query: {} })
  // @ts-expect-error no request body on this operation
  void api("GET /pets", { body: {} })
  // @ts-expect-error the body is required
  void api("POST /pets")
  // @ts-expect-error body type is checked
  void api("POST /pets", { body: { name: 1 } })
  void api("PATCH /pets/{id}", { params: { id: 1 } })
  // The only declared media type is the default; a JSON one is otherwise.
  void api("PATCH /pets/{id}", { params: { id: 1 }, body: { name: "x" } })
  void api("POST /charges", { body: { amount: 1 } })
  // @ts-expect-error the body is still checked
  void api("POST /charges", { body: { amount: "1" } })
  // @ts-expect-error two media types and no JSON: the call names one
  void api("POST /upload", { body: { file: new Blob([]) } })
  void api("POST /upload", { contentType: "multipart/form-data", body: { file: new Blob([]) } })
  // @ts-expect-error the body must match the chosen media type
  void api("POST /upload", { contentType: "multipart/form-data", body: { name: "x" } })
  // @ts-expect-error only declared media types
  void api("POST /token", { contentType: "application/json", body: { grant_type: "x" } })
  // Declared headers keep their types; others are free-form.
  void api("GET /pets/{id}", { params: { id: 1 }, headers: { "X-Trace": "t", "X-Other": "o" } })
  // @ts-expect-error unknown endpoint
  void api("GET /nope")
}

describe("types", () => {
  const api = createClient({ contract })

  it("derives results from the response map", () => {
    expect(api).toBeTypeOf("function")
    expectTypeOf<SuccessOf<Endpoints["GET /pets"]>>().toEqualTypeOf<Schemas.Pet[]>()
    expectTypeOf<SuccessOf<Endpoints["DELETE /pets/{id}"]>>().toEqualTypeOf<undefined>()
    expectTypeOf<SuccessOf<Endpoints["GET /search"]>>().toEqualTypeOf<string>()
    expectTypeOf<SuccessOf<Endpoints["GET /health"]>>().toEqualTypeOf<unknown>()
    expectTypeOf<ErrorOf<Endpoints["GET /pets/{id}"]>>().toEqualTypeOf<Schemas.Error>()
    expectTypeOf<ReturnType<typeof api<"GET /pets/{id}">>>().resolves.toEqualTypeOf<Schemas.Pet>()
  })

  it("infers endpoints, credentials, and adapter options from what it is given", () => {
    expect(inferenceChecks).toBeTypeOf("function")
    expectTypeOf<SuccessOf<Endpoints["GET /events"]>>().toEqualTypeOf<
      Array<{ data: string; event?: string }>
    >()
  })

  it("requires what the operation requires", () => {
    expect(requirementChecks).toBeTypeOf("function")
  })
})

describe("reserved characters, delimiters, and path segments", () => {
  interface Api {
    "GET /files/{path}": { params: { path: string }; response: Record<never, never> }
    "GET /q": { query: Record<string, unknown>; response: Record<never, never> }
  }
  const api = createClient({
    contract: contractFor<Api>({
      "GET /files/{path}": {
        params: { path: { style: "simple", explode: false, allowReserved: true } },
      },
      "GET /q": {
        query: {
          next: { style: "form", explode: true, allowReserved: true },
          ids: { style: "form", explode: false },
          sp: { style: "spaceDelimited", explode: false },
          pipe: { style: "pipeDelimited", explode: false },
        },
      },
    }),
    adapter: echo("url"),
  })

  it("keeps reserved characters only where they cannot change the URL", async () => {
    expect(await api("GET /files/{path}", { params: { path: "a/b c%20d#e?f" } })).toBe(
      "/files/a/b%20c%20d%23e%3Ff",
    )
    expect(await api("GET /q", { query: { next: "a#b&c=d/e?f%20g" } })).toBe(
      "/q?next=a%23b%26c%3Dd/e?f%20g",
    )
  })

  it("keeps commas between values, and percent-encodes spaces and pipes", async () => {
    const query = { ids: ["a,b", "c"], sp: { R: 100, G: 200 }, pipe: { R: 100, G: 200 } }
    expect(await api("GET /q", { query })).toBe(
      "/q?ids=a%2Cb,c&sp=R%20100%20G%20200&pipe=R%7C100%7CG%7C200",
    )
  })

  it("refuses path values that would reach another resource", async () => {
    for (const path of ["..", ".", "", "a/../b", "%2e%2E", "/a"]) {
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      await expect(api("GET /files/{path}", { params: { path } })).rejects.toThrow(
        "another resource",
      )
    }
  })
})

describe("choosing credentials", () => {
  interface Api {
    "GET /optional": { response: Record<never, never> }
    "GET /tls-first": { response: Record<never, never> }
    "GET /fallback": { response: Record<never, never> }
    "GET /anonymous": { response: Record<never, never> }
    "GET /undeclared": { response: Record<never, never> }
  }
  const secured: Contract<Api, { bearer?: string; key?: string }> = {
    servers: [],
    security: {
      bearer: { type: "http", scheme: "bearer" },
      key: { type: "apiKey", in: "header", name: "X-Key" },
      tls: { type: "mutualTLS" },
    },
    endpoints: {
      "GET /optional": { requires: [{}, { bearer: [] }] },
      "GET /tls-first": { requires: [{ tls: [] }, { bearer: [] }] },
      "GET /fallback": { requires: [{ bearer: [] }, { key: [] }] },
      "GET /anonymous": { requires: [] },
    },
  }
  const headersFor = (
    security: Parameters<
      typeof createClient<Api, { bearer?: string; key?: string }>
    >[0]["security"],
    endpoint: keyof Api,
  ): Promise<unknown> =>
    createClient({ contract: secured, security, adapter: echo("headers") })(endpoint)

  it("sends the credentials given when the operation accepts them", async () => {
    expect(await headersFor({ bearer: "t" }, "GET /optional")).toStrictEqual({
      authorization: "Bearer t",
    })
    expect(await headersFor({ bearer: "t" }, "GET /tls-first")).toStrictEqual({
      authorization: "Bearer t",
    })
    expect(await headersFor({ bearer: "t", key: "k" }, "GET /anonymous")).toStrictEqual({})
  })

  it("resolves each credential once per request", async () => {
    let calls = 0
    const bearer = (): string | undefined => {
      calls++
      return undefined
    }
    await headersFor({ bearer, key: "k" }, "GET /fallback")
    expect(calls).toBe(1)
  })

  it("tries the next requirement when a credential function returns nothing", async () => {
    expect(
      await headersFor({ bearer: () => undefined as never, key: "k" }, "GET /fallback"),
    ).toStrictEqual({
      "x-key": "k",
    })
  })

  it("sends what it is given where no security is declared", async () => {
    expect(await headersFor({ bearer: "t", key: "k" }, "GET /undeclared")).toStrictEqual({
      "authorization": "Bearer t",
      "x-key": "k",
    })
  })
})

describe("bodies by media type", () => {
  interface Api {
    "POST /json": { body: { "text/json": { a: number } }; response: Record<never, never> }
    "POST /form": {
      body: { "application/x-www-form-urlencoded": string }
      response: Record<never, never>
    }
    "POST /text": { body: { "text/*": string }; response: Record<never, never> }
    "PUT /raw": { body: { "application/octet-stream": Blob }; response: Record<never, never> }
  }
  const requests: AdapterRequest[] = []
  const api = createClient({
    contract: contractFor<Api>({
      "POST /json": { contentType: "text/json" },
      "POST /form": { contentType: "application/x-www-form-urlencoded" },
      "POST /text": { contentType: "text/*" },
      "PUT /raw": { contentType: "application/octet-stream" },
    }),
    adapter: (request) => {
      requests.push(request)
      return Promise.resolve()
    },
  })

  it("encodes each as the client declares, and passes streams through", async () => {
    await api("POST /json", { body: { a: 1 } })
    await api("POST /form", { body: "a=1&b=2" })
    await api("POST /text", { body: "hi" })
    const stream = chunks()
    await api("PUT /raw", { body: stream as never })
    expect(requests.map((r) => [r.body, r.headers["content-type"]])).toStrictEqual([
      ['{"a":1}', "text/json"],
      ["a=1&b=2", "application/x-www-form-urlencoded"],
      ["hi", "text/plain"],
      [stream, "application/octet-stream"],
    ])
    await expect(api("POST /text", { body: 1 as never })).rejects.toThrow("must be a string")
    // JSON, form fields, and parameters have no room for bytes: a Blob there is
    // refused, not sent as {}.
    await expect(api("POST /json", { body: { a: new Blob([]) } as never })).rejects.toThrow(
      "A Blob cannot be sent inside JSON",
    )
    const fields = createClient({
      contract: contractFor<{
        "POST /f": {
          query: { q?: Blob }
          body: { "application/x-www-form-urlencoded": { f?: Blob } }
          response: Record<never, never>
        }
      }>({ "POST /f": { contentType: "application/x-www-form-urlencoded" } }),
      adapter: () => Promise.resolve(),
    })
    await expect(fields("POST /f", { query: { q: new Blob([]) }, body: {} })).rejects.toThrow(
      "A Blob cannot be sent as text",
    )
    await expect(fields("POST /f", { body: { f: new Blob([]) } })).rejects.toThrow(
      "A Blob cannot be sent as text",
    )
    // Wherever the client writes JSON: object parts, content parameters, sequences, encoded fields.
    const json = createClient({
      contract: contractFor<{
        "POST /m": {
          query: { q?: object }
          body: {
            "multipart/form-data": { meta?: object }
            "application/x-ndjson": object[]
            "application/x-www-form-urlencoded": { f?: object }
          }
          response: Record<never, never>
        }
      }>({
        "POST /m": {
          query: { q: { contentType: "application/json" } },
          encoding: {
            "application/x-www-form-urlencoded": { f: { contentType: "application/json" } },
          },
        },
      }),
      adapter: () => Promise.resolve(),
    })
    const data = { data: new Blob([]) }
    for (const call of [
      () => json("POST /m", { contentType: "multipart/form-data", body: { meta: data } }),
      () => json("POST /m", { query: { q: data }, contentType: "application/x-ndjson", body: [] }),
      () => json("POST /m", { contentType: "application/x-ndjson", body: [data] }),
      () =>
        json("POST /m", { contentType: "application/x-www-form-urlencoded", body: { f: data } }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      await expect(call()).rejects.toThrow("A Blob cannot be sent inside JSON")
    }
  })

  it("streams request bodies through fetch in half duplex", async () => {
    let init: (RequestInit & { duplex?: string }) | undefined
    const adapter = fetchAdapter((_url, given) => {
      init = given
      return Promise.resolve(new Response(null, { status: 204 }))
    })
    await adapter({
      method: "PUT",
      url: "/raw",
      headers: {},
      body: new ReadableStream() as never,
      options: undefined,
    })
    expect(init?.duplex).toBe("half")
  })

  it("lets a body bring its own content type, and finds declared headers in any case", async () => {
    const { api: fixture, requests: sent } = recording({
      headers: { "Content-Type": "application/json" },
    })
    await fixture("POST /upload", {
      contentType: "multipart/form-data",
      body: { file: new Blob([]) },
    })
    await fixture("GET /files/{names}", {
      params: { names: ["a"] },
      headers: { "x-range": { from: 5 } },
    })
    expect(sent[0].headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/)
    expect(sent[1].headers["x-range"]).toBe("from=5")
  })
})

describe("decoding responses", () => {
  it("decodes by the same media classes as the types", async () => {
    expect(await decode('{"a":1}', "text/json")).toStrictEqual({ a: 1 })
    expect(await decode("event: ping\n\ndata: x\n\n", "text/event-stream")).toStrictEqual([
      { data: "x" },
    ])
    expect(await decode("", "image/png")).toBeInstanceOf(Blob)
    expect(await decode(null)).toBeUndefined()
  })
})

/** Compile-time checks: adapter options and credentials. Never called. */
function optionChecks(): void {
  const api = createClient({ contract, options: { cache: "no-store" } })
  void api("GET /pets", { options: { keepalive: true } })
  // @ts-expect-error options are the adapter's, checked rather than inferred
  void createClient({ contract, options: { chache: "no-store" } })
  // @ts-expect-error no security schemes, so no credentials
  void createClient({ contract: contractFor<Endpoints>(), security: { token: "x" } })
  const wildcard = createClient({
    contract: contractFor<{
      "PUT /x": { body: { "*/*": { a: number } }; response: Record<never, never> }
    }>(),
  })
  // @ts-expect-error contentType names a declared media type
  void wildcard("PUT /x", { contentType: "text/plain", body: { a: 1 } })
}

describe("option types", () => {
  it("takes adapter options from the adapter, and credentials only for declared schemes", () => {
    expect(optionChecks).toBeTypeOf("function")
  })
})
