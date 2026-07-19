import { describe, expect, it } from "vitest"
import { buildContract } from "../../../src/core/contract/build"
import { BuildError } from "../../../src/core/contract/errors"
import type { Contract } from "../../../src/core/contract/model"

function endpointOperations(contract: Contract) {
  return contract.operations.filter((operation) => operation.kind === "endpoint")
}

function webhookOperations(contract: Contract) {
  return contract.operations.filter((operation) => operation.kind === "webhook")
}

function callbackOperations(contract: Contract) {
  return contract.operations.filter((operation) => operation.kind === "callback")
}

describe("contract: endpoint key/method/path/meta", () => {
  it("METHOD path key, method lowercase, path raw", () => {
    const contract = buildContract({
      paths: { "/pets": { get: { responses: { "200": { description: "ok" } } } } },
    })
    expect(endpointOperations(contract)[0].key).toBe("GET /pets")
    expect(endpointOperations(contract)[0].method).toBe("get")
    expect(endpointOperations(contract)[0].path).toBe("/pets")
    expect(endpointOperations(contract)[0].source).toStrictEqual({ location: "/paths/~1pets/get" })
  })

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
    })
    expect(endpointOperations(contract)[0]).toMatchObject({
      operationId: "list",
      tags: ["t1"],
      deprecated: true,
    })
  })

  it("3.1 missing responses yields an empty responses list", () => {
    const contract = buildContract({
      openapi: "3.1.0",
      paths: { "/pets": { get: {} } },
    })
    expect(endpointOperations(contract)[0].responses).toStrictEqual([])
  })

  it("3.0 requires responses", () => {
    expect(() =>
      buildContract({
        openapi: "3.0.3",
        paths: { "/pets": { get: {} } },
      }),
    ).toThrow(BuildError)
  })
})

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
    })
    expect(endpointOperations(contract)[0].params).toStrictEqual([
      { name: "id", required: true, type: { kind: "scalar", name: "string" }, docs: undefined },
    ])
  })

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
    })
    expect(endpointOperations(contract)[0].query).toStrictEqual([
      {
        name: "limit",
        required: true,
        type: { kind: "scalar", name: "number" },
        docs: undefined,
      },
      {
        name: "tag",
        required: false,
        type: { kind: "scalar", name: "string" },
        docs: undefined,
      },
    ])
  })

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
    })
    expect(endpointOperations(contract)[0].query[0]).toStrictEqual({
      name: "q",
      required: true,
      type: { kind: "scalar", name: "number" },
      docs: undefined,
    })
  })
})

describe("contract: body", () => {
  it("none when no requestBody", () => {
    const contract = buildContract({
      paths: { "/p": { post: { responses: { "200": { description: "ok" } } } } },
    })
    expect(endpointOperations(contract)[0].body).toStrictEqual({ kind: "none" })
  })

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
    })
    expect(endpointOperations(contract)[0].body).toStrictEqual({
      kind: "json",
      required: true,
      type: { kind: "scalar", name: "string" },
    })
  })

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
    })
    expect(endpointOperations(contract)[0].body).toMatchObject({ kind: "json", required: false })
  })

  it("keeps a false JSON body schema as never", () => {
    const contract = buildContract({
      paths: {
        "/p": {
          post: {
            requestBody: { content: { "application/json": { schema: false } } },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    })
    expect(endpointOperations(contract)[0].body).toStrictEqual({
      kind: "json",
      required: false,
      type: { kind: "never" },
    })
  })

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
    })
    expect(endpointOperations(contract)[0].body.kind).toBe("passthrough")
  })
})

describe("contract: response map", () => {
  it("emits one entry per declared status, preserving OpenAPI order", () => {
    const contract = buildContract({
      paths: {
        "/p": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
              "400": { content: { "application/json": { schema: { type: "string" } } } },
              "5XX": { description: "no content" },
              "default": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    })
    expect(endpointOperations(contract)[0].responses.map((r) => r.status)).toStrictEqual([
      "200",
      "400",
      "5XX",
      "default",
    ])
  })

  it("picks JSON content type and records it on the entry", () => {
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
    })
    expect(endpointOperations(contract)[0].responses[0]).toStrictEqual({
      status: "200",
      type: { kind: "scalar", name: "string" },
      contentType: "application/json",
      source: { location: "/paths/~1p/get/responses/200" },
    })
  })

  it("binary content type produces a binary type", () => {
    const contract = buildContract({
      paths: {
        "/p": {
          get: {
            responses: {
              "200": { content: { "application/octet-stream": {} } },
            },
          },
        },
      },
    })
    expect(endpointOperations(contract)[0].responses[0].type).toStrictEqual({
      kind: "binary",
    })
  })

  it("no-content response becomes a void type", () => {
    const contract = buildContract({
      paths: { "/p": { delete: { responses: { "204": { description: "ok" } } } } },
    })
    expect(endpointOperations(contract)[0].responses[0].type).toStrictEqual({
      kind: "void",
    })
  })

  it("empty responses map produces an empty entry list", () => {
    const contract = buildContract({ paths: { "/p": { get: { responses: {} } } } })
    expect(endpointOperations(contract)[0].responses).toStrictEqual([])
  })
})

describe("contract: webhooks", () => {
  it("webhook key uses METHOD <name> and source location uses /webhooks", () => {
    const contract = buildContract({
      webhooks: {
        "pet.created": { post: { responses: { "200": { description: "ok" } } } },
      },
    })
    expect(webhookOperations(contract)).toHaveLength(1)
    expect(webhookOperations(contract)[0].key).toBe("POST pet.created")
    expect(webhookOperations(contract)[0].method).toBe("post")
    expect(webhookOperations(contract)[0].name).toBe("pet.created")
    expect(webhookOperations(contract)[0].source).toStrictEqual({
      location: "/webhooks/pet.created/post",
    })
  })

  it("webhook with multiple methods produces an entry per method in HTTP_METHODS order", () => {
    const contract = buildContract({
      webhooks: {
        ping: {
          post: { responses: { "200": { description: "ok" } } },
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    })
    expect(webhookOperations(contract).map((e) => e.key)).toStrictEqual(["GET ping", "POST ping"])
  })

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
    })
    expect(webhookOperations(contract)[0].body).toStrictEqual({
      kind: "json",
      required: true,
      type: { kind: "scalar", name: "string" },
    })
    expect(webhookOperations(contract)[0].responses[0]).toMatchObject({
      status: "200",
      type: { kind: "scalar", name: "boolean" },
    })
  })

  it("source location escapes slashes in webhook names", () => {
    const contract = buildContract({
      webhooks: {
        "pet/created": { post: { responses: { "200": { description: "ok" } } } },
      },
    })
    expect(webhookOperations(contract)[0].source).toStrictEqual({
      location: "/webhooks/pet~1created/post",
    })
  })

  it("webhook missing responses yields an empty responses list", () => {
    const contract = buildContract({
      webhooks: { ping: { post: {} } },
    })
    expect(webhookOperations(contract)[0].responses).toStrictEqual([])
  })

  it("paths and webhooks build independently into one operations collection", () => {
    const contract = buildContract({
      paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
      webhooks: { ping: { post: { responses: { "200": { description: "ok" } } } } },
    })
    expect(contract.operations.map((op) => `${op.kind}:${op.key}`)).toStrictEqual([
      "endpoint:GET /x",
      "webhook:POST ping",
    ])
  })
})

describe("contract: callbacks", () => {
  it("builds callback operations with collision-resistant keys", () => {
    const contract = buildContract({
      paths: {
        "/subscribe": {
          post: {
            callbacks: {
              onEvent: {
                "{$request.body#/callbackUrl}": {
                  post: {
                    requestBody: {
                      required: true,
                      content: { "application/json": { schema: { type: "string" } } },
                    },
                    responses: { "204": { description: "accepted" } },
                  },
                },
              },
            },
            responses: { "202": { description: "subscribed" } },
          },
        },
      },
    })
    expect(callbackOperations(contract)).toHaveLength(1)
    expect(callbackOperations(contract)[0]).toMatchObject({
      kind: "callback",
      key: "POST /subscribe > onEvent > POST {$request.body#/callbackUrl}",
      parentKey: "POST /subscribe",
      callbackName: "onEvent",
      expression: "{$request.body#/callbackUrl}",
      body: { kind: "json", required: true },
    })
  })
})
