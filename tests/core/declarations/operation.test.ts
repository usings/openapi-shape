import { describe, expect, it } from "vitest"
import type { EndpointOperation } from "../../../src/core/contract/model"
import { renderOperationEntry } from "../../../src/core/declarations/operation"

const operation: EndpointOperation = {
  kind: "endpoint",
  key: 'POST /quote/"x"',
  method: "post",
  path: '/quote/"x"',
  tags: [],
  deprecated: false,
  params: [{ name: "user-id", required: true, type: { kind: "scalar", name: "string" } }],
  query: [{ name: "limit", required: false, type: { kind: "scalar", name: "number" } }],
  headers: [{ name: "X-Trace", required: true, type: { kind: "scalar", name: "string" } }],
  body: { kind: "json", required: false, type: { kind: "reference", name: "Input" } },
  responses: [
    { status: "200", type: { kind: "reference", name: "Result" } },
    { status: "default", type: { kind: "void" } },
  ],
}

describe("renderOperationEntry", () => {
  it("renders shared operation fields, types, options, and escaped keys", () => {
    const out = renderOperationEntry(
      operation,
      { params: operation.params, bodyKey: "body", responseKey: "response" },
      { headers: true },
    )

    expect(out).toContain('"POST /quote/\\"x\\"": {')
    expect(out).toContain('params: { "user-id": string }')
    expect(out).toContain("query: { limit?: number }")
    expect(out).toContain('headers: { "X-Trace": string }')
    expect(out).toContain("body?: Schemas.Input")
    expect(out).toContain('response: { "200": Schemas.Result; "default": void }')
  })
})
