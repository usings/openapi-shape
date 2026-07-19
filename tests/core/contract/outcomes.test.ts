import { describe, expect, it } from "vitest"
import { buildContract } from "../../../src/core/contract/build"
import { isJsonContentType } from "../../../src/core/contract/outcomes"

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
})
