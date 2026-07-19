import { describe, expect, it } from "vitest"
import type { EndpointOperation } from "../../../src/core/contract/contract"
import { renderEndpointsInterface } from "../../../src/core/declarations/endpoint"

const baseEndpoint: EndpointOperation = {
  kind: "endpoint",
  key: "GET /pets",
  method: "get",
  path: "/pets",
  tags: [],
  deprecated: false,
  params: [],
  query: [],
  headers: [],
  body: { kind: "none" },
  responses: [],
}

describe("renderEndpointsInterface: default", () => {
  it("void params/query/body, unknown response when no responses declared", () => {
    expect(renderEndpointsInterface([baseEndpoint])).toBe(
      `export interface Endpoints {\n  "GET /pets": {\n    params: void\n    query: void\n    body: void\n    response: unknown\n  }\n}`,
    )
  })

  it("renders query fields", () => {
    expect(
      renderEndpointsInterface([
        {
          ...baseEndpoint,
          query: [{ name: "limit", required: false, shape: { kind: "scalar", name: "number" } }],
          responses: [{ status: "200", shape: { kind: "scalar", name: "string" } }],
        },
      ]),
    ).toContain("query: { limit?: number }")
  })

  it("query params with invalid identifier names are JSON-quoted (uses safeKey)", () => {
    const out = renderEndpointsInterface([
      {
        ...baseEndpoint,
        query: [
          { name: "user-id", required: false, shape: { kind: "scalar", name: "string" } },
          { name: "x-request-id", required: true, shape: { kind: "scalar", name: "string" } },
        ],
        responses: [{ status: "200", shape: { kind: "scalar", name: "string" } }],
      },
    ])
    expect(out).toContain('"user-id"?: string')
    expect(out).toContain('"x-request-id": string')
  })

  it("path params with invalid identifier names are JSON-quoted (uses safeKey)", () => {
    const out = renderEndpointsInterface([
      {
        ...baseEndpoint,
        params: [{ name: "user-id", required: true, shape: { kind: "scalar", name: "string" } }],
        responses: [{ status: "200", shape: { kind: "scalar", name: "string" } }],
      },
    ])
    expect(out).toContain('"user-id": string')
  })

  it("body required vs optional", () => {
    expect(
      renderEndpointsInterface([
        {
          ...baseEndpoint,
          body: { kind: "json", required: true, shape: { kind: "scalar", name: "string" } },
        },
      ]),
    ).toContain("body: string")
    expect(
      renderEndpointsInterface([
        {
          ...baseEndpoint,
          body: { kind: "json", required: false, shape: { kind: "scalar", name: "string" } },
        },
      ]),
    ).toContain("body?: string")
  })

  it("escapes endpoint keys as string literals", () => {
    const out = renderEndpointsInterface([{ ...baseEndpoint, key: 'GET /quote/"x"' }])
    expect(out).toContain('"GET /quote/\\"x\\"": {')
  })
})

describe("renderEndpointsInterface: response map", () => {
  it("emits every declared response keyed by status", () => {
    const out = renderEndpointsInterface([
      {
        ...baseEndpoint,
        responses: [
          { status: "200", shape: { kind: "scalar", name: "string" } },
          {
            status: "400",
            shape: { kind: "reference", name: "Validation" },
          },
          {
            status: "5XX",
            shape: { kind: "reference", name: "ServerError" },
          },
        ],
      },
    ])
    expect(out).toContain(
      'response: { "200": string; "400": Schemas.Validation; "5XX": Schemas.ServerError }',
    )
  })

  it("renders the `default` status as a literal key", () => {
    const out = renderEndpointsInterface([
      {
        ...baseEndpoint,
        responses: [{ status: "default", shape: { kind: "scalar", name: "string" } }],
      },
    ])
    expect(out).toContain('response: { "default": string }')
  })
})
