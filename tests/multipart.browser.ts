import { expect, it } from "vitest"
import type { Contract } from "../src/client"
import type { BodyLike } from "../src/client/types"
import { recorder } from "./helpers/client"
import type { ResultOperation } from "./helpers/contract"

const multipart = "multipart/form-data"

it("encodes multipart bodies as FormData", async () => {
  const { client, sent } = recorder<{
    "POST /m": ResultOperation<{
      body: Record<string, unknown> | BodyLike
      contentType?: "multipart/form-data"
    }>
  }>({
    version: 6,
    endpoints: {
      "POST /m": {
        contentType: "multipart/form-data",
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
  await client.fetch("POST /m", { body })
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
    version: 6,
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
  const { client, requests } = recorder(contract, { baseURL: "https://api.test" })
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
