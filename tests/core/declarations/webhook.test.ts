import { describe, expect, it } from "vitest";
import type { WebhookOperation } from "../../../src/core/contract/contract";
import { renderWebhooksInterface } from "../../../src/core/declarations/webhook";

const baseWebhook: WebhookOperation = {
  kind: "webhook",
  key: "POST pet.created",
  method: "post",
  name: "pet.created",
  tags: [],
  deprecated: false,
  query: [],
  headers: [],
  body: { kind: "none" },
  responses: [],
};

describe("renderWebhooksInterface: default", () => {
  it("emits void query / void payload / unknown reply when empty, and no params field", () => {
    expect(renderWebhooksInterface([baseWebhook])).toBe(
      `export interface Webhooks {\n  "POST pet.created": {\n    query: void\n    payload: void\n    reply: unknown\n  }\n}`,
    );
  });

  it("uses 'payload' instead of 'body'", () => {
    const out = renderWebhooksInterface([
      {
        ...baseWebhook,
        body: { kind: "json", required: true, shape: { kind: "primitive", name: "string" } },
      },
    ]);
    expect(out).toContain("payload: string");
    expect(out).not.toContain("body:");
  });

  it("payload required vs optional", () => {
    const required = renderWebhooksInterface([
      {
        ...baseWebhook,
        body: { kind: "json", required: true, shape: { kind: "primitive", name: "string" } },
      },
    ]);
    const optional = renderWebhooksInterface([
      {
        ...baseWebhook,
        body: { kind: "json", required: false, shape: { kind: "primitive", name: "string" } },
      },
    ]);
    expect(required).toContain("payload: string");
    expect(optional).toContain("payload?: string");
  });

  it("uses 'reply' instead of 'response'", () => {
    const out = renderWebhooksInterface([
      {
        ...baseWebhook,
        responses: [{ status: "200", shape: { kind: "primitive", name: "boolean" } }],
      },
    ]);
    expect(out).toContain('reply: { "200": boolean }');
    expect(out).not.toContain("response:");
  });

  it("renders query fields", () => {
    expect(
      renderWebhooksInterface([
        {
          ...baseWebhook,
          query: [
            { name: "version", required: false, shape: { kind: "primitive", name: "string" } },
          ],
        },
      ]),
    ).toContain("query: { version?: string }");
  });

  it("query keys with invalid identifiers are JSON-quoted (uses safeKey)", () => {
    const out = renderWebhooksInterface([
      {
        ...baseWebhook,
        query: [{ name: "x-trace", required: true, shape: { kind: "primitive", name: "string" } }],
      },
    ]);
    expect(out).toContain('"x-trace": string');
  });

  it("escapes webhook keys as string literals", () => {
    const out = renderWebhooksInterface([{ ...baseWebhook, key: 'POST quote/"x"' }]);
    expect(out).toContain('"POST quote/\\"x\\"": {');
  });
});

describe("renderWebhooksInterface: headers option", () => {
  const wh: WebhookOperation = {
    ...baseWebhook,
    headers: [
      { name: "X-Signature", required: true, shape: { kind: "primitive", name: "string" } },
    ],
  };
  it("omits headers field by default", () => {
    expect(renderWebhooksInterface([wh])).not.toContain("headers:");
  });
  it("emits headers field when option is true", () => {
    expect(renderWebhooksInterface([wh], { headers: true })).toContain(
      'headers: { "X-Signature": string }',
    );
  });
});

describe("renderWebhooksInterface: reply map", () => {
  it("emits every declared response keyed by status", () => {
    const out = renderWebhooksInterface([
      {
        ...baseWebhook,
        responses: [
          { status: "200", shape: { kind: "primitive", name: "boolean" } },
          {
            status: "400",
            shape: { kind: "schema", schema: { $ref: "#/components/schemas/BadRequest" } },
          },
        ],
      },
    ]);
    expect(out).toContain('reply: { "200": boolean; "400": Schemas.BadRequest }');
  });
});
