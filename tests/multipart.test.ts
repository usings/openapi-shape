import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import type { Contract } from "../src/client"
import { createClient } from "../src/client"
import { generate } from "../src/core/index"
import type { ResultOperation } from "./helpers/contract"
import { contractOf } from "./helpers/contract"
import type { Version } from "./helpers/generate"
import { codes, oas } from "./helpers/generate"

const multipart = "multipart/form-data"
const form = "application/x-www-form-urlencoded"
function document(content: object, version: Version = "3.2") {
  return oas(version, {
    paths: {
      "/upload": {
        post: { requestBody: { content }, responses: { "204": { description: "OK" } } },
      },
    },
  })
}
async function generatedClient(content: object) {
  const { code, diagnostics } = await generate(document(content))
  expect(diagnostics).toStrictEqual([])
  const contract = await contractOf<{
    "POST /upload": ResultOperation<{
      body: Record<string, unknown> | FormData
      contentType?: typeof multipart | `${typeof multipart};${string}` | typeof form
    }>
  }>(code)
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

it("types declared parts and keeps undeclared or text/plain values as text fields", async () => {
  const { client, requests } = await generatedClient({
    [multipart]: {
      schema: { type: "object" },
      encoding: {
        meta: { contentType: "application/vnd.meta+json" },
        count: { contentType: "application/json" },
        note: { contentType: "text/markdown" },
        files: { contentType: "image/png" },
        raw: { contentType: "application/custom" },
        plain: { contentType: "text/plain; charset=utf-8" },
      },
    },
  })
  await client.fetch("POST /upload", {
    contentType: multipart,
    body: {
      meta: { id: 1 },
      count: 3,
      note: "# hi",
      raw: new Uint8Array([1, 2]),
      files: [new File(["A"], "a.png", { type: "text/plain" }), new File(["B"], "b.png")],
      plain: "x",
      defaults: [{ id: 2 }, [1, 2]],
      skipped: null,
    },
  })
  const request = requests[0]
  expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
  const parts = await request.formData()
  expect(parts.get("meta")).toMatchObject({ type: "application/vnd.meta+json" })
  expect(await (parts.get("meta") as Blob).text()).toBe('{"id":1}')
  expect(parts.get("count")).toMatchObject({ type: "application/json" })
  expect(await (parts.get("count") as Blob).text()).toBe("3")
  expect(parts.get("note")).toMatchObject({ type: "text/markdown" })
  expect(await (parts.get("note") as Blob).text()).toBe("# hi")
  expect(parts.getAll("files")).toMatchObject([
    { name: "a.png", type: "image/png" },
    { name: "b.png", type: "image/png" },
  ])
  expect(parts.get("raw")).toMatchObject({ type: "application/custom" })
  expect(new Uint8Array(await (parts.get("raw") as Blob).arrayBuffer())).toStrictEqual(
    new Uint8Array([1, 2]),
  )
  // Text fields, not files: only a Blob carries a part's type, and it makes the part a file.
  expect(parts.get("plain")).toBe("x")
  expect(parts.getAll("defaults")).toStrictEqual(['{"id":2}', "[1,2]"])
  expect(parts.has("skipped")).toBe(false)
})

it("applies explicit styles without percent encoding or contentType, even at default style values", async () => {
  const { client, requests } = await generatedClient({
    [multipart]: {
      schema: { type: "object" },
      encoding: {
        tags: { explode: false },
        obj: { style: "form", explode: true, contentType: "application/json" },
        deep: { style: "deepObject" },
        pipes: { style: "pipeDelimited" },
        spaces: { style: "spaceDelimited" },
        compact: { style: "form", explode: false },
        reserved: { allowReserved: false, contentType: "application/json" },
      },
    },
  })
  await client.fetch("POST /upload", {
    contentType: multipart,
    body: {
      tags: ["a%", "b+&", null],
      obj: { "k+": "a&b" },
      deep: { "x&": ["%", "+"] },
      pipes: ["x", "y"],
      spaces: ["x", "y"],
      compact: { a: "x", b: "y" },
      reserved: { plain: true },
    },
  })
  expect([...(await requests[0].formData())]).toStrictEqual([
    ["tags", "a%,b+&"],
    ["k+", "a&b"],
    ["deep[x&][0]", "%"],
    ["deep[x&][1]", "+"],
    ["pipes", "x|y"],
    ["spaces", "x y"],
    ["compact", "a,x,b,y"],
    ["plain", "true"],
  ])
})

it("isolates full media type variants and handles prototype-like field names", async () => {
  const variant = `${multipart};profile=compact`
  const encoding = JSON.parse('{"__proto__":{"contentType":"application/json"}}') as object
  const { client, requests } = await generatedClient({
    [multipart]: { schema: { type: "object" }, encoding },
    [variant]: { schema: { type: "object" }, encoding: { tags: { explode: false } } },
    [form]: { schema: { type: "object" }, encoding: { tags: { style: "pipeDelimited" } } },
  })
  const body = JSON.parse('{"tags":["x","y"],"__proto__":{"id":1}}') as Record<string, unknown>
  for (const contentType of [multipart, variant, form] as const) {
    // oxlint-disable-next-line no-await-in-loop -- inspect the selected variant
    await client.fetch("POST /upload", { contentType, body })
  }
  const normal = await requests[0].formData()
  const compact = await requests[1].formData()
  expect(normal.getAll("tags")).toStrictEqual(["x", "y"])
  expect(compact.getAll("tags")).toStrictEqual(["x,y"])
  expect(normal.get("__proto__")).toMatchObject({ type: "application/json" })
  expect(await requests[2].text()).toBe("tags=x%7Cy&id=1")
})

it("reports unsupported multipart configuration at its field", async () => {
  const { diagnostics } = await generate(
    document({
      [multipart]: {
        schema: { type: "object" },
        prefixEncoding: [],
        itemEncoding: {},
        encoding: {
          file: { headers: { "X-Part": { schema: { type: "string" } } }, contentType: "image/*" },
          // The spec has the Encoding Object ignore a Content-Type header.
          typed: { headers: { "content-type": { schema: { type: "string" } } } },
          nested: { encoding: {}, prefixEncoding: [], itemEncoding: {} },
          list: { contentType: "image/png, image/jpeg" },
          empty: { contentType: "" },
          bad: { style: "matrix" },
        },
      },
    }),
  )
  const prefix = "ignored-field #/paths/~1upload/post/requestBody/content/multipart~1form-data/"
  expect(codes(diagnostics)).toStrictEqual(
    [
      "prefixEncoding",
      "itemEncoding",
      "encoding/file/headers",
      "encoding/file/contentType",
      "encoding/nested/encoding",
      "encoding/nested/prefixEncoding",
      "encoding/nested/itemEncoding",
      "encoding/list/contentType",
      "encoding/empty/contentType",
      "encoding/bad/style",
    ].map((path) => prefix + path),
  )
})

it("records named part encodings only for form-data, and styles only from OpenAPI 3.1", async () => {
  // multipart/mixed takes a ready body, so its encodings are neither recorded nor reported.
  const mixed = await generate(
    document({
      "multipart/mixed": {
        schema: { type: "object" },
        encoding: { a: { contentType: "application/json", headers: { "X-A": {} } } },
      },
    }),
  )
  expect(mixed.diagnostics).toStrictEqual([])
  expect(mixed.code).not.toContain("bodyEncodings")
  // OpenAPI 3.0 applies style, explode, and allowReserved to URL-encoded forms only.
  const legacy = await generate(
    document(
      {
        [multipart]: {
          schema: { type: "object" },
          encoding: {
            tags: { style: "matrix", explode: false, contentType: "application/json" },
            plain: { explode: false },
          },
        },
      },
      "3.0",
    ),
  )
  expect(legacy.diagnostics).toStrictEqual([])
  expect(legacy.code).toContain(
    `bodyEncodings: { "${multipart}": { tags: { contentType: "application/json" } } }`,
  )
})

it("sends JSON null parts but omits other nullish values", async () => {
  const { client, requests } = await generatedClient({
    [multipart]: {
      schema: { type: "object" },
      encoding: {
        meta: { contentType: "application/json" },
        list: { contentType: "application/json" },
        gone: { contentType: "application/json" },
        note: { contentType: "text/plain" },
        tags: { style: "form" },
      },
    },
  })
  await client.fetch("POST /upload", {
    contentType: multipart,
    body: {
      meta: null,
      list: [null, undefined, 1],
      gone: undefined,
      note: null,
      tags: null,
      x: null,
    },
  })
  const parts = await requests[0].formData()
  expect([...parts.keys()]).toStrictEqual(["meta", "list", "list"])
  expect(
    await Promise.all((parts.getAll("list") as Blob[]).map((part) => part.text())),
  ).toStrictEqual(["null", "1"])
  expect(await (parts.get("meta") as Blob).text()).toBe("null")
})

it.each([
  ["a Blob", new Blob(["A"])],
  ["a buffer", new Uint8Array([1, 2])],
  ["an ArrayBuffer", new ArrayBuffer(2)],
  ["a file array", [new File(["A"], "a.png")]],
  ["an object of buffers", { a: new Uint8Array([1]) }],
  ["a nested buffer", [{ a: { b: new Uint8Array([1]) } }]],
])("rejects %s in a styled field rather than corrupt it", async (_, value) => {
  const { client, requests } = await generatedClient({
    [multipart]: { schema: { type: "object" }, encoding: { files: { style: "form" } } },
  })
  await expect(
    client.fetch("POST /upload", { contentType: multipart, body: { files: value } }),
  ).rejects.toThrow('Multipart field "files" is declared with a style')
  expect(requests).toHaveLength(0)
})

it("treats any style field of a hand-written contract as style-based, ignoring contentType", async () => {
  const requests: Request[] = []
  const contract = {
    version: 5,
    endpoints: {
      "POST /upload": {
        bodyEncodings: {
          [multipart]: {
            compact: { explode: false, contentType: "application/json" },
            styled: { style: "form", contentType: "application/json" },
            reserved: { allowReserved: true },
          },
        },
      },
    },
  } as Contract<{
    "POST /upload": ResultOperation<{
      body: Record<string, unknown>
      contentType?: typeof multipart
    }>
  }>
  const client = createClient(contract, {
    baseUrl: "https://api.test",
    fetch: (request) => {
      requests.push(request)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  await client.fetch("POST /upload", {
    contentType: multipart,
    body: { compact: ["x", "y"], styled: null, reserved: "a b&c" },
  })
  expect([...(await requests[0].formData())]).toStrictEqual([
    ["compact", "x,y"],
    ["reserved", "a b&c"],
  ])
  await expect(
    client.fetch("POST /upload", { contentType: multipart, body: { compact: [new Blob(["A"])] } }),
  ).rejects.toThrow('Multipart field "compact" is declared with a style')
})

it("preserves ready FormData despite declared part encodings", async () => {
  const { client, requests } = await generatedClient({
    [multipart]: {
      schema: { type: "object" },
      encoding: { meta: { contentType: "application/json" } },
    },
  })
  const body = new FormData()
  body.append("meta", "already encoded")
  await client.fetch("POST /upload", { contentType: multipart, body })
  const parts = await requests[0].formData()
  expect(parts.get("meta")).toBe("already encoded")
})

it("encodes cross-realm multipart objects and buffers and rejects nested styled binary", async () => {
  const { client, requests } = await generatedClient({
    [multipart]: {
      schema: { type: "object" },
      encoding: {
        meta: { contentType: "application/json" },
        styled: { style: "deepObject" },
      },
    },
  })
  const body = runInNewContext(
    "({ meta: { id: 1 }, file: new Uint8Array([65, 66]).buffer })",
  ) as Record<string, unknown>
  await client.fetch("POST /upload", { contentType: multipart, body })
  const parts = await requests[0].formData()
  expect(await (parts.get("meta") as Blob).text()).toBe('{"id":1}')
  expect(await (parts.get("file") as Blob).text()).toBe("AB")
  const styled = runInNewContext("({ styled: { nested: [new ArrayBuffer(2)] } })") as Record<
    string,
    unknown
  >
  await expect(
    client.fetch("POST /upload", { contentType: multipart, body: styled }),
  ).rejects.toThrow('Multipart field "styled" is declared with a style')
})

it("preserves a branded File's name when retyping without the local File prototype", async () => {
  const file = new File(["binary"], "original.bin")
  Object.setPrototypeOf(
    file,
    Object.create(Blob.prototype, Object.getOwnPropertyDescriptors(File.prototype)),
  )
  expect(file).not.toBeInstanceOf(File)
  const { client, requests } = await generatedClient({
    [multipart]: {
      schema: { type: "object" },
      encoding: { file: { contentType: "application/octet-stream" } },
    },
  })
  await client.fetch("POST /upload", { contentType: multipart, body: { file } })
  const parts = await requests[0].formData()
  const part = parts.get("file") as File
  expect(part.name).toBe("original.bin")
  expect(part.type).toBe("application/octet-stream")
  expect(await part.text()).toBe("binary")
})
