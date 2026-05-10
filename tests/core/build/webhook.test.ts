import { describe, expect, it } from "vitest";
import { buildIR } from "../../../src/core/build";
import { BuildError } from "../../../src/core/build/errors";

describe("buildIR: webhooks", () => {
  it("webhook key uses METHOD <name> and source location uses /webhooks", () => {
    const ir = buildIR({
      webhooks: {
        "pet.created": { post: { responses: { "200": { description: "ok" } } } },
      },
    });
    expect(ir.webhooks).toHaveLength(1);
    expect(ir.webhooks[0].key).toBe("POST pet.created");
    expect(ir.webhooks[0].method).toBe("post");
    expect(ir.webhooks[0].path).toBe("pet.created");
    expect(ir.webhooks[0].source).toStrictEqual({ location: "/webhooks/pet.created/post" });
  });

  it("webhook with multiple methods produces an entry per method in HTTP_METHODS order", () => {
    const ir = buildIR({
      webhooks: {
        ping: {
          post: { responses: { "200": { description: "ok" } } },
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
    expect(ir.webhooks.map((e) => e.key)).toStrictEqual(["GET ping", "POST ping"]);
  });

  it("webhook body and response mirror endpoint shape", () => {
    const ir = buildIR({
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
    expect(ir.webhooks[0].body).toStrictEqual({
      kind: "json",
      required: true,
      type: { kind: "primitive", name: "string" },
    });
    expect(ir.webhooks[0].responses.success).toStrictEqual({ kind: "primitive", name: "boolean" });
  });

  it("source location escapes slashes in webhook names", () => {
    const ir = buildIR({
      webhooks: {
        "pet/created": { post: { responses: { "200": { description: "ok" } } } },
      },
    });
    expect(ir.webhooks[0].source).toStrictEqual({ location: "/webhooks/pet~1created/post" });
  });

  it("throws when a webhook operation is missing responses", () => {
    expect(() =>
      buildIR({
        webhooks: { ping: { post: {} } },
      }),
    ).toThrow(BuildError);
  });

  it("paths and webhooks build independently into separate IR fields", () => {
    const ir = buildIR({
      paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
      webhooks: { ping: { post: { responses: { "200": { description: "ok" } } } } },
    });
    expect(ir.endpoints.map((e) => e.key)).toStrictEqual(["GET /x"]);
    expect(ir.webhooks.map((e) => e.key)).toStrictEqual(["POST ping"]);
  });
});
