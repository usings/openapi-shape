import { describe, expect, it } from "vitest";
import { buildContract } from "../../../src/core/contract/build";
import type { Contract } from "../../../src/core/contract/contract";
import { BuildError } from "../../../src/core/contract/errors";

function endpointOperations(contract: Contract) {
  return contract.operations.filter((operation) => operation.kind === "endpoint");
}

function webhookOperations(contract: Contract) {
  return contract.operations.filter((operation) => operation.kind === "webhook");
}

describe("contract: endpoint key/method/path/meta", () => {
  it("METHOD path key, method lowercase, path raw", () => {
    const contract = buildContract({
      paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
    });
    expect(endpointOperations(contract)[0].key).toBe("GET /pets");
    expect(endpointOperations(contract)[0].method).toBe("get");
    expect(endpointOperations(contract)[0].path).toBe("/pets");
    expect(endpointOperations(contract)[0].source).toStrictEqual({ location: "/paths/~1pets/get" });
  });

  it("captures operationId/tags/deprecated", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0]).toMatchObject({
      operationId: "list",
      tags: ["t1"],
      deprecated: true,
    });
  });

  it("throws when an operation is missing responses", () => {
    expect(() =>
      buildContract({
        paths: { "/pets": { get: {} } },
      }),
    ).toThrow(BuildError);
  });
});

describe("contract: params", () => {
  it("path params always typed string regardless of declared schema", () => {
    const contract = buildContract({
      paths: {
        "/p/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(endpointOperations(contract)[0].params.fields).toStrictEqual([
      { name: "id", required: true, shape: { kind: "primitive", name: "string" }, docs: undefined },
    ]);
  });

  it("query params from schema, required from parameter.required", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].query.fields).toStrictEqual([
      {
        name: "limit",
        required: true,
        shape: { kind: "schema", schema: { type: "integer" } },
        docs: undefined,
      },
      {
        name: "tag",
        required: false,
        shape: { kind: "schema", schema: { type: "string" } },
        docs: undefined,
      },
    ]);
  });

  it("operation params override path-item params on same in:name", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].query.fields[0]).toStrictEqual({
      name: "q",
      required: true,
      shape: { kind: "schema", schema: { type: "integer" } },
      docs: undefined,
    });
  });
});

describe("contract: body", () => {
  it("none when no requestBody", () => {
    const contract = buildContract({
      paths: { "/p": { post: { responses: { "200": { description: "ok" } } } } },
    });
    expect(endpointOperations(contract)[0].body).toStrictEqual({ kind: "none" });
  });

  it("json body required true", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].body).toStrictEqual({
      kind: "json",
      required: true,
      shape: { kind: "schema", schema: { type: "string" } },
    });
  });

  it("body required defaults to false when omitted", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].body).toMatchObject({ kind: "json", required: false });
  });

  it("passthrough body for non-json content-type", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].body.kind).toBe("passthrough");
  });
});

describe("contract: success response", () => {
  it("2xx json", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].responses.success).toStrictEqual({
      kind: "schema",
      schema: { type: "string" },
    });
    expect(endpointOperations(contract)[0].responses.successStatus).toBe("200");
    expect(endpointOperations(contract)[0].responses.successContentType).toBe("application/json");
  });

  it("status order matters: 200 binary wins over 201 json", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].responses.success).toStrictEqual({
      kind: "primitive",
      name: "Blob",
    });
  });

  it("2xx no-content → void", () => {
    const contract = buildContract({
      paths: { "/p": { delete: { responses: { "204": { description: "ok" } } } } },
    });
    expect(endpointOperations(contract)[0].responses.success).toStrictEqual({
      kind: "primitive",
      name: "void",
    });
  });

  it("falls back to default when no 2xx", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].responses.success).toStrictEqual({
      kind: "schema",
      schema: { type: "string" },
    });
  });

  it("null when nothing matches", () => {
    const contract = buildContract({ paths: { "/p": { get: { responses: {} } } } });
    expect(endpointOperations(contract)[0].responses.success).toBeNull();
  });
});

describe("contract: error collection", () => {
  it("collects 4xx/5xx + 4XX/5XX, skips default, skips no-content", () => {
    const contract = buildContract({
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
    expect(endpointOperations(contract)[0].responses.errors.map((e) => e.status)).toStrictEqual([
      "400",
      "4XX",
      "500",
    ]);
    expect(endpointOperations(contract)[0].responses.errors[0]).toMatchObject({
      contentType: "application/json",
      source: { location: "/responses/400" },
    });
  });
});

describe("contract: webhooks", () => {
  it("webhook key uses METHOD <name> and source location uses /webhooks", () => {
    const contract = buildContract({
      webhooks: {
        "pet.created": { post: { responses: { "200": { description: "ok" } } } },
      },
    });
    expect(webhookOperations(contract)).toHaveLength(1);
    expect(webhookOperations(contract)[0].key).toBe("POST pet.created");
    expect(webhookOperations(contract)[0].method).toBe("post");
    expect(webhookOperations(contract)[0].name).toBe("pet.created");
    expect(webhookOperations(contract)[0].source).toStrictEqual({
      location: "/webhooks/pet.created/post",
    });
  });

  it("webhook with multiple methods produces an entry per method in HTTP_METHODS order", () => {
    const contract = buildContract({
      webhooks: {
        ping: {
          post: { responses: { "200": { description: "ok" } } },
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    expect(webhookOperations(contract).map((e) => e.key)).toStrictEqual(["GET ping", "POST ping"]);
  });

  it("webhook body and response mirror endpoint shape", () => {
    const contract = buildContract({
      webhooks: {
        "pet.created": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "string" } } },
            },
            responses: {
              "200": { content: { "application/json": { schema: { type: "boolean" } } } },
            },
          },
        },
      },
    });
    expect(webhookOperations(contract)[0].body).toStrictEqual({
      kind: "json",
      required: true,
      shape: { kind: "schema", schema: { type: "string" } },
    });
    expect(webhookOperations(contract)[0].responses.success).toStrictEqual({
      kind: "schema",
      schema: { type: "boolean" },
    });
  });

  it("source location escapes slashes in webhook names", () => {
    const contract = buildContract({
      webhooks: {
        "pet/created": { post: { responses: { "200": { description: "ok" } } } },
      },
    });
    expect(webhookOperations(contract)[0].source).toStrictEqual({
      location: "/webhooks/pet~1created/post",
    });
  });

  it("throws when a webhook operation is missing responses", () => {
    expect(() =>
      buildContract({
        webhooks: { ping: { post: {} } },
      }),
    ).toThrow(BuildError);
  });

  it("paths and webhooks build independently into one operations collection", () => {
    const contract = buildContract({
      paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
      webhooks: { ping: { post: { responses: { "200": { description: "ok" } } } } },
    });
    expect(contract.operations.map((op) => `${op.kind}:${op.key}`)).toStrictEqual([
      "endpoint:GET /x",
      "webhook:POST ping",
    ]);
  });
});
