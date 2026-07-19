import { describe, expect, it } from "vitest"
import { buildContract } from "../../../src/core/contract/build"
import { isJsonContentType } from "../../../src/core/contract/outcomes"
import type { MediaType, OpenAPISchema } from "../../../src/core/openapi/types"

function responseType(content: Record<string, MediaType>) {
  const contract = buildContract({
    paths: { "/x": { get: { responses: { "200": { content } } } } },
  })
  const endpoint = contract.operations.find((operation) => operation.kind === "endpoint")
  return endpoint?.responses[0].type
}

describe("isJsonContentType", () => {
  it.each([
    "application/json",
    "application/json; charset=utf-8",
    "application/problem+json",
    "text/json",
  ])("accepts JSON-family media type %s", (contentType) => {
    expect(isJsonContentType(contentType)).toBe(true)
  })

  it.each(["application/notjson", "text/json-seq", "application/xml"])(
    "rejects non-JSON media type %s",
    (contentType) => {
      expect(isJsonContentType(contentType)).toBe(false)
    },
  )

  it("prefers a real JSON response over an earlier subtype containing json", () => {
    const contract = buildContract({
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/notjson": { schema: { type: "string" } },
                  "application/json": { schema: { type: "number" } },
                },
              },
            },
          },
        },
      },
    })
    const endpoint = contract.operations.find((operation) => operation.kind === "endpoint")
    expect(endpoint?.responses[0].type).toStrictEqual({
      kind: "scalar",
      name: "number",
    })
  })

  it("keeps a false JSON response schema as never", () => {
    const contract = buildContract({
      paths: {
        "/x": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: false } } },
            },
          },
        },
      },
    })
    const endpoint = contract.operations.find((operation) => operation.kind === "endpoint")
    expect(endpoint?.responses[0].type).toStrictEqual({ kind: "never" })
  })

  it.each(["text/plain", "application/octet-stream", "application/x-custom"])(
    "keeps a false %s response schema as never",
    (contentType) => {
      const contract = buildContract({
        paths: {
          "/x": {
            get: {
              responses: {
                "200": { content: { [contentType]: { schema: false } } },
              },
            },
          },
        },
      })
      const endpoint = contract.operations.find((operation) => operation.kind === "endpoint")
      expect(endpoint?.responses[0].type).toStrictEqual({ kind: "never" })
    },
  )

  it.each([
    ["binary content without a schema", "application/octet-stream", undefined, { kind: "binary" }],
    ["text content", "text/plain", undefined, { kind: "scalar", name: "string" }],
    [
      "an unknown content schema",
      "application/x-custom",
      { type: "number" },
      { kind: "scalar", name: "number" },
    ],
    ["unknown content without a schema", "application/x-custom", undefined, { kind: "binary" }],
  ])("maps %s", (_name, contentType, schema, expected) => {
    const media: MediaType = schema === undefined ? {} : { schema: schema as OpenAPISchema }
    expect(responseType({ [contentType as string]: media })).toStrictEqual(expected)
  })
})
