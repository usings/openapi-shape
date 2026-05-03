import { describe, expect, it } from "vitest";
import { renderEndpointsInterface } from "../../src/render/endpoint";
import type { EndpointModel } from "../../src/ir/types";

const baseEndpoint: EndpointModel = {
  key: "GET /pets",
  method: "get",
  path: "/pets",
  tags: [],
  deprecated: false,
  params: { fields: [] },
  query: { fields: [] },
  body: { kind: "none", required: true, type: null },
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
              { name: "limit", required: false, type: { kind: "primitive", name: "number" } },
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
            { name: "user-id", required: false, type: { kind: "primitive", name: "string" } },
            { name: "x-request-id", required: true, type: { kind: "primitive", name: "string" } },
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
            { name: "user-id", required: true, type: { kind: "primitive", name: "string" } },
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
          body: { kind: "json", required: true, type: { kind: "primitive", name: "string" } },
        },
      ]),
    ).toContain("body: string");
    expect(
      renderEndpointsInterface([
        {
          ...baseEndpoint,
          body: { kind: "json", required: false, type: { kind: "primitive", name: "string" } },
        },
      ]),
    ).toContain("body?: string");
  });
});

describe("renderEndpointsInterface: errors option", () => {
  const ep: EndpointModel = {
    ...baseEndpoint,
    responses: {
      success: { kind: "primitive", name: "string" },
      errors: [
        { status: "400", type: { kind: "ref", name: "Validation" } },
        { status: "5XX", type: { kind: "ref", name: "ServerError" } },
      ],
    },
  };
  it("omits errors field by default", () => {
    expect(renderEndpointsInterface([ep])).not.toContain("errors:");
  });
  it("emits errors field when option is true", () => {
    expect(renderEndpointsInterface([ep], { errors: true })).toContain(
      'errors: { "400": Validation; "5XX": ServerError }',
    );
  });
  it("omits errors field when no error responses", () => {
    expect(renderEndpointsInterface([baseEndpoint], { errors: true })).not.toContain("errors:");
  });
});

describe("renderEndpointsInterface: endpointKey option", () => {
  const ep: EndpointModel = {
    ...baseEndpoint,
    operationId: "listPets",
    responses: { success: { kind: "primitive", name: "string" }, errors: [] },
  };
  it("default = method-path key", () => {
    expect(renderEndpointsInterface([ep])).toContain('"GET /pets"');
  });
  it("operation-id mode uses operationId", () => {
    expect(renderEndpointsInterface([ep], { endpointKey: "operation-id" })).toContain('"listPets"');
  });
  it("operation-id falls back to method-path when operationId missing", () => {
    expect(renderEndpointsInterface([baseEndpoint], { endpointKey: "operation-id" })).toContain(
      '"GET /pets"',
    );
  });
  it("function form", () => {
    expect(
      renderEndpointsInterface([ep], { endpointKey: (e) => `${e.method}:${e.path}` }),
    ).toContain('"get:/pets"');
  });
});
