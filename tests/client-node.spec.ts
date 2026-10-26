import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import { contract } from "./__snapshots__/client-api"
import { recorder, shared, url } from "./helpers/client"
import type { ResultOperation } from "./helpers/contract"

// A Node.js-style stream: an async iterable of bytes.
async function* chunks(): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(new Uint8Array([1]))
}

it("serializes cross-realm plain objects and Dates as ordinary parameter values", async () => {
  const { client, sent } = recorder<{
    "GET /files/{meta}": ResultOperation<{
      params: { meta: object }
      query: Record<string, unknown>
    }>
  }>({
    version: 6,
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

it("accepts shared-memory bytes and Node streaming body extensions", async () => {
  const { client, sent } = recorder(contract)
  // fetch takes no shared memory, and some runtimes would send it as text.
  await client.fetch("POST /upload", {
    contentType: "application/octet-stream",
    body: new Uint8Array(shared([1, 2])),
  })
  expect(new Uint8Array(await sent().arrayBuffer())).toStrictEqual(new Uint8Array([1, 2]))
  for (const body of [
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    }),
    chunks(),
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
    await client.fetch("POST /upload", { contentType: "application/octet-stream", body })
    // Streaming request bodies go in half duplex.
    expect((sent() as Request & { duplex?: string }).duplex).toBe("half")
    // oxlint-disable-next-line no-await-in-loop -- consume each upload before inspecting the next
    expect(new Uint8Array(await sent().arrayBuffer())).toStrictEqual(new Uint8Array([1]))
  }
})

it("preserves repeated Set-Cookie request headers in Node", async () => {
  const { client, sent } = recorder(contract)
  // Repeated names, as `new Headers()` keeps them.
  const cookies = new Headers([
    ["set-cookie", "a=1"],
    ["set-cookie", "b=2"],
  ])
  await client.fetch("GET /pets", { headers: cookies })
  expect(sent().headers.getSetCookie()).toStrictEqual(["a=1", "b=2"])
})

it("encodes shared memory as multipart bytes", async () => {
  const { client, sent } = recorder<{
    "POST /m": ResultOperation<{ body: Record<string, unknown> }>
  }>({
    version: 6,
    endpoints: { "POST /m": { contentType: "multipart/form-data" } },
  })
  await client.fetch("POST /m", {
    body: { buffer: shared([3]), view: new Uint8Array(shared([4])) },
  })
  const parts = await sent().formData()
  expect(new Uint8Array(await (parts.get("buffer") as Blob).arrayBuffer())).toStrictEqual(
    new Uint8Array([3]),
  )
  expect(new Uint8Array(await (parts.get("view") as Blob).arrayBuffer())).toStrictEqual(
    new Uint8Array([4]),
  )
})
