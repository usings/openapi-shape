import { describe, expect, it } from "vitest";
import { buildIR } from "../../src/ir";

describe("buildIR: endpoint key/method/path/meta", () => {
  it("METHOD path key, method lowercase, path raw", () => {
    const ir = buildIR({
      paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
    });
    expect(ir.endpoints[0].key).toBe("GET /pets");
    expect(ir.endpoints[0].method).toBe("get");
    expect(ir.endpoints[0].path).toBe("/pets");
  });

  it("captures operationId/tags/deprecated", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          get: {
            operationId: "list",
            tags: ["t1"],
            deprecated: true,
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(ir.endpoints[0]).toMatchObject({
      operationId: "list",
      tags: ["t1"],
      deprecated: true,
    });
  });
});

describe("buildIR: params", () => {
  it("path params always typed string regardless of declared schema", () => {
    const ir = buildIR({
      paths: {
        "/p/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(ir.endpoints[0].params.fields).toEqual([
      { name: "id", required: true, type: { kind: "primitive", name: "string" } },
    ]);
  });

  it("query params from schema, required from parameter.required", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          get: {
            parameters: [
              { name: "limit", in: "query", required: true, schema: { type: "integer" } },
              { name: "tag", in: "query", schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(ir.endpoints[0].query.fields).toEqual([
      { name: "limit", required: true, type: { kind: "primitive", name: "number" } },
      { name: "tag", required: false, type: { kind: "primitive", name: "string" } },
    ]);
  });

  it("operation params override path-item params on same in:name", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
          get: {
            parameters: [{ name: "q", in: "query", required: true, schema: { type: "integer" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(ir.endpoints[0].query.fields[0]).toEqual({
      name: "q",
      required: true,
      type: { kind: "primitive", name: "number" },
    });
  });
});

describe("buildIR: body", () => {
  it("none when no requestBody", () => {
    const ir = buildIR({
      paths: { "/p": { post: { responses: { "200": { description: "ok" } } } } },
    });
    expect(ir.endpoints[0].body).toEqual({ kind: "none", required: true, type: null });
  });

  it("json body required true", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "string" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(ir.endpoints[0].body).toEqual({
      kind: "json",
      required: true,
      type: { kind: "primitive", name: "string" },
    });
  });

  it("body required defaults to false when omitted", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { type: "string" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(ir.endpoints[0].body.required).toBe(false);
  });

  it("passthrough body for non-json content-type", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          post: {
            requestBody: {
              content: {
                "multipart/form-data": { schema: { type: "string", format: "binary" } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(ir.endpoints[0].body.kind).toBe("passthrough");
  });
});

describe("buildIR: success response", () => {
  it("2xx json", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    });
    expect(ir.endpoints[0].responses.success).toEqual({ kind: "primitive", name: "string" });
  });

  it("status order matters: 200 binary wins over 201 json", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          get: {
            responses: {
              "200": { content: { "application/octet-stream": {} } },
              "201": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    });
    expect(ir.endpoints[0].responses.success).toEqual({ kind: "primitive", name: "Blob" });
  });

  it("2xx no-content → void", () => {
    const ir = buildIR({
      paths: { "/p": { delete: { responses: { "204": { description: "ok" } } } } },
    });
    expect(ir.endpoints[0].responses.success).toEqual({ kind: "primitive", name: "void" });
  });

  it("falls back to default when no 2xx", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          get: {
            responses: {
              default: { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    });
    expect(ir.endpoints[0].responses.success).toEqual({ kind: "primitive", name: "string" });
  });

  it("null when nothing matches", () => {
    const ir = buildIR({ paths: { "/p": { get: { responses: {} } } } });
    expect(ir.endpoints[0].responses.success).toBe(null);
  });
});

describe("buildIR: error collection", () => {
  it("collects 4xx/5xx + 4XX/5XX, skips default, skips no-content", () => {
    const ir = buildIR({
      paths: {
        "/p": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
              "400": {
                content: { "application/json": { schema: { $ref: "#/components/schemas/V" } } },
              },
              "4XX": { content: { "application/json": { schema: { type: "string" } } } },
              "500": { content: { "application/json": { schema: { type: "string" } } } },
              "5XX": { description: "no content" },
              default: { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    });
    expect(ir.endpoints[0].responses.errors.map((e) => e.status)).toEqual(["400", "4XX", "500"]);
  });
});
