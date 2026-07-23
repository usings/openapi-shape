import { describe, expect, it } from "vitest"
import type { EndpointOperation } from "../../../src/core/contract/model"
import { renderEndpointsInterface } from "../../../src/core/declarations/endpoint"

const endpoint: EndpointOperation = {
  kind: "endpoint",
  key: "GET /pets",
  method: "get",
  path: "/pets",
  tags: [],
  deprecated: false,
  params: [],
  query: [],
  headers: [],
  cookies: [],
  body: { kind: "none" },
  responses: [],
}

describe("renderEndpointsInterface", () => {
  it("uses endpoint-side params, body, and response vocabulary", () => {
    expect(renderEndpointsInterface([endpoint])).toBe(
      `export interface Endpoints {\n  "GET /pets": {\n    params: void\n    query: void\n    body: void\n    response: unknown\n  }\n}`,
    )
  })
})
