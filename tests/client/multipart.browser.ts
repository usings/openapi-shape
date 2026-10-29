import { expect, it } from "vitest"
import type { Contract } from "../../src/client"
import type { BodyLike } from "../../src/client/types/request"
import { recorder } from "../support/client"
import type { ResultOperation } from "../support/contract"

const multipart = "multipart/form-data"

it("encodes multipart bodies as FormData", async () => {
  const { client, sent } = recorder<{
    "POST /m": ResultOperation<{
      body: Record<"multipart/form-data", Record<string, unknown> | BodyLike>
    }>
  }>({
    version: 7,
    endpoints: {
      "POST /m": {
        requestBody: { required: false, content: { "multipart/form-data": {} } },
        responses: { default: { content: { "*/*": {} } } },
      },
    },
  })
  const body = {
    photo: new File(["PNG"], "photo.png", { type: "image/png" }),
    raw: new Blob(["x"]),
    meta: { a: 1 },
    tags: ["x", "y"],
    when: new Date(0),
    bytes: new Uint8Array([1, 2]),
    skipped: undefined,
  }
  await client.fetch("POST /m", { headers: { "content-type": "multipart/form-data" }, body })
  expect(sent().headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/)
  const fields = await sent().formData()
  expect(fields.get("photo")).toMatchObject({ name: "photo.png", type: "image/png" })
  // A Blob without a name is still a file.
  expect(fields.get("raw")).toMatchObject({ name: "blob" })
  expect(fields.get("meta")).toBe('{"a":1}')
  expect(fields.getAll("tags")).toStrictEqual(["x", "y"])
  expect(fields.get("when")).toBe("1970-01-01T00:00:00.000Z")
  // Typed arrays are bytes, not textual array representations.
  expect(new Uint8Array(await (fields.get("bytes") as Blob).arrayBuffer())).toStrictEqual(
    new Uint8Array([1, 2]),
  )
  expect(fields.has("skipped")).toBe(false)
})

it("treats any style field of a hand-written contract as style-based, ignoring contentType", async () => {
  const contract = {
    version: 7,
    endpoints: {
      "POST /upload": {
        requestBody: {
          required: false,
          content: Object.fromEntries(
            Object.entries({
              [multipart]: {
                compact: { explode: false, contentType: "application/json" },
                styled: { style: "form", contentType: "application/json" },
                reserved: { allowReserved: true },
              },
            }).map(([media, encoding]) => [media, { encoding }]),
          ),
        },
        responses: { default: { content: { "*/*": {} } } },
      },
    },
  } as Contract<{
    "POST /upload": ResultOperation<{ body: Record<typeof multipart, Record<string, unknown>> }>
  }>
  const { client, requests } = recorder(contract, { baseURL: "https://api.test" })
  await client.fetch("POST /upload", {
    body: { compact: ["x", "y"], styled: null, reserved: "a b&c" },
    headers: { "content-type": "multipart/form-data" },
  })
  expect([...(await requests[0].formData())]).toStrictEqual([
    ["compact", "x,y"],
    ["reserved", "a b&c"],
  ])
  await expect(
    client.fetch("POST /upload", {
      body: { compact: [new Blob(["A"])] },
      headers: { "content-type": "multipart/form-data" },
    }),
  ).rejects.toThrow('Multipart field "compact" is declared with a style')
})
