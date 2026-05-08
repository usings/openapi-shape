import { describe, expect, it } from "vitest";
import { generate } from "../src/index";
import { expectPassesTsc } from "./_helpers/tsc";

describe("generate: webhooks (integration)", () => {
  it("emits a Webhooks interface keyed by method + name", () => {
    const code = generate({
      webhooks: {
        "pet.created": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(code).toContain("export interface Webhooks");
    expect(code).toContain('"POST pet.created"');
    expect(code).toMatch(/payload:\s*\{\s*id:\s*string\s*\}/);
    expect(code).toContain("reply: void");
  });

  it("entries have no params field (no URL templating)", () => {
    const code = generate({
      webhooks: {
        ping: { post: { responses: { "200": { description: "ok" } } } },
      },
    });
    const webhookBlock = code.slice(code.indexOf("export interface Webhooks"));
    expect(webhookBlock).not.toContain("params");
  });

  it("renames body→payload and response→reply vs endpoints", () => {
    const code = generate({
      paths: {
        "/x": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "string" } } },
            },
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
      webhooks: {
        "x.event": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "string" } } },
            },
            responses: {
              "200": { content: { "application/json": { schema: { type: "string" } } } },
            },
          },
        },
      },
    });
    const endpointsBlock = code.slice(
      code.indexOf("export interface Endpoints"),
      code.indexOf("export interface Webhooks"),
    );
    const webhooksBlock = code.slice(code.indexOf("export interface Webhooks"));
    expect(endpointsBlock).toContain("body: string");
    expect(endpointsBlock).toContain("response: string");
    expect(endpointsBlock).not.toContain("payload:");
    expect(endpointsBlock).not.toContain("reply:");
    expect(webhooksBlock).toContain("payload: string");
    expect(webhooksBlock).toContain("reply: string");
    expect(webhooksBlock).not.toContain("body:");
    expect(webhooksBlock).not.toContain("response:");
  });

  it("omits Webhooks interface when document has no webhooks", () => {
    const code = generate({
      paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
    });
    expect(code).not.toContain("Webhooks");
  });

  it("coexist with paths in the same document", () => {
    const code = generate({
      paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
      webhooks: {
        ping: { post: { responses: { "200": { description: "ok" } } } },
      },
    });
    expect(code).toContain("export interface Endpoints");
    expect(code).toContain("export interface Webhooks");
    expect(code).toContain('"POST ping"');
  });

  it("emit @summary and @deprecated JSDoc tags on entries", () => {
    const code = generate({
      webhooks: {
        "pet.created": {
          post: {
            summary: "Fired when a new pet is created",
            deprecated: true,
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(code).toContain("@summary Fired when a new pet is created");
    expect(code).toContain("@deprecated");
  });

  it("respects the headers: true option", () => {
    const code = generate(
      {
        webhooks: {
          "pet.created": {
            post: {
              parameters: [
                { name: "X-Signature", in: "header", required: true, schema: { type: "string" } },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      { headers: true },
    );
    expect(code).toContain("export interface Webhooks");
    expect(code).toMatch(/headers:\s*\{\s*"X-Signature":\s*string\s*\}/);
  });

  it("$ref bodies resolve against components", () => {
    const code = generate({
      components: {
        schemas: {
          Pet: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
      webhooks: {
        "pet.updated": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(code).toContain("payload: Pet");
    expect(code).toContain("export interface Pet");
  });

  it("generated output passes tsc as .d.ts", async () => {
    const code = generate({
      paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
      webhooks: {
        "pet.created": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    await expectPassesTsc([code]);
  });
});
