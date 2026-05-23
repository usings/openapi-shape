import { describe, expect, it } from "vitest";
import type { EndpointOperation } from "../../../src/core/contract/contract";
import { renderEndpointsInterface } from "../../../src/core/declarations/endpoint";

const baseEndpoint: EndpointOperation = {
  kind: "endpoint",
  key: "GET /pets",
  method: "get",
  path: "/pets",
  tags: [],
  deprecated: false,
  params: { fields: [] },
  query: { fields: [] },
  headers: { fields: [] },
  body: { kind: "none" },
  responses: { success: null, errors: [] },
};

describe("renderEndpointsInterface: default", () => {
  it("void params/query/body, unknown response when empty", () => {
    expect(renderEndpointsInterface([baseEndpoint])).toBe(
      `export interface Endpoints {\n  "GET /pets": {\n    params: void\n    query: void\n    body: void\n    response: unknown\n  }\n}`,
    );
  });

  it("renders query fields", () => {
    expect(
      renderEndpointsInterface([
        {
          ...baseEndpoint,
          query: {
            fields: [
              { name: "limit", required: false, shape: { kind: "primitive", name: "number" } },
            ],
          },
          responses: { success: { kind: "primitive", name: "string" }, errors: [] },
        },
      ]),
    ).toContain("query: { limit?: number }");
  });

  it("query params with invalid identifier names are JSON-quoted (uses safeKey)", () => {
    const out = renderEndpointsInterface([
      {
        ...baseEndpoint,
        query: {
          fields: [
            { name: "user-id", required: false, shape: { kind: "primitive", name: "string" } },
            { name: "x-request-id", required: true, shape: { kind: "primitive", name: "string" } },
          ],
        },
        responses: { success: { kind: "primitive", name: "string" }, errors: [] },
      },
    ]);
    expect(out).toContain('"user-id"?: string');
    expect(out).toContain('"x-request-id": string');
  });

  it("path params with invalid identifier names are JSON-quoted (uses safeKey)", () => {
    const out = renderEndpointsInterface([
      {
        ...baseEndpoint,
        params: {
          fields: [
            { name: "user-id", required: true, shape: { kind: "primitive", name: "string" } },
          ],
        },
        responses: { success: { kind: "primitive", name: "string" }, errors: [] },
      },
    ]);
    expect(out).toContain('"user-id": string');
  });

  it("body required vs optional", () => {
    expect(
      renderEndpointsInterface([
        {
          ...baseEndpoint,
          body: { kind: "json", required: true, shape: { kind: "primitive", name: "string" } },
        },
      ]),
    ).toContain("body: string");
    expect(
      renderEndpointsInterface([
        {
          ...baseEndpoint,
          body: { kind: "json", required: false, shape: { kind: "primitive", name: "string" } },
        },
      ]),
    ).toContain("body?: string");
  });

  it("escapes endpoint keys as string literals", () => {
    const out = renderEndpointsInterface([{ ...baseEndpoint, key: 'GET /quote/"x"' }]);
    expect(out).toContain('"GET /quote/\\"x\\"": {');
  });
});

describe("renderEndpointsInterface: errors option", () => {
  const ep: EndpointOperation = {
    ...baseEndpoint,
    responses: {
      success: { kind: "primitive", name: "string" },
      errors: [
        {
          status: "400",
          shape: { kind: "schema", schema: { $ref: "#/components/schemas/Validation" } },
        },
        {
          status: "5XX",
          shape: { kind: "schema", schema: { $ref: "#/components/schemas/ServerError" } },
        },
      ],
    },
  };
  it("omits errors field by default", () => {
    expect(renderEndpointsInterface([ep])).not.toContain("errors:");
  });
  it("emits errors field when option is true", () => {
    expect(renderEndpointsInterface([ep], { errors: true })).toContain(
      'errors: { "400": Schemas.Validation; "5XX": Schemas.ServerError }',
    );
  });
  it("omits errors field when no error responses", () => {
    expect(renderEndpointsInterface([baseEndpoint], { errors: true })).not.toContain("errors:");
  });
});
