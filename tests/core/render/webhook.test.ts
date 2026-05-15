import { describe, expect, it } from "vitest";
import type { EndpointModel } from "../../../src/core/build/ir";
import { renderWebhooksInterface } from "../../../src/core/render/webhook";

const baseWebhook: EndpointModel = {
  key: "POST pet.created",
  method: "post",
  path: "pet.created",
  tags: [],
  deprecated: false,
  params: { fields: [] },
  query: { fields: [] },
  headers: { fields: [] },
  body: { kind: "none" },
  responses: { success: null, errors: [] },
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
        body: { kind: "json", required: true, type: { kind: "primitive", name: "string" } },
      },
    ]);
    expect(out).toContain("payload: string");
    expect(out).not.toContain("body:");
  });

  it("payload required vs optional", () => {
    const required = renderWebhooksInterface([
      {
        ...baseWebhook,
        body: { kind: "json", required: true, type: { kind: "primitive", name: "string" } },
      },
    ]);
    const optional = renderWebhooksInterface([
      {
        ...baseWebhook,
        body: { kind: "json", required: false, type: { kind: "primitive", name: "string" } },
      },
    ]);
    expect(required).toContain("payload: string");
    expect(optional).toContain("payload?: string");
  });

  it("uses 'reply' instead of 'response'", () => {
    const out = renderWebhooksInterface([
      {
        ...baseWebhook,
        responses: { success: { kind: "primitive", name: "boolean" }, errors: [] },
      },
    ]);
    expect(out).toContain("reply: boolean");
    expect(out).not.toContain("response:");
  });

  it("renders query fields", () => {
    expect(
      renderWebhooksInterface([
        {
          ...baseWebhook,
          query: {
            fields: [
              { name: "version", required: false, type: { kind: "primitive", name: "string" } },
            ],
          },
        },
      ]),
    ).toContain("query: { version?: string }");
  });

  it("query keys with invalid identifiers are JSON-quoted (uses safeKey)", () => {
    const out = renderWebhooksInterface([
      {
        ...baseWebhook,
        query: {
          fields: [
            { name: "x-trace", required: true, type: { kind: "primitive", name: "string" } },
          ],
        },
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
  const wh: EndpointModel = {
    ...baseWebhook,
    headers: {
      fields: [
        { name: "X-Signature", required: true, type: { kind: "primitive", name: "string" } },
      ],
    },
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

describe("renderWebhooksInterface: errors option", () => {
  const wh: EndpointModel = {
    ...baseWebhook,
    responses: {
      success: { kind: "primitive", name: "boolean" },
      errors: [{ status: "400", type: { kind: "ref", name: "BadRequest" } }],
    },
  };
  it("omits errors field by default", () => {
    expect(renderWebhooksInterface([wh])).not.toContain("errors:");
  });
  it("emits errors field when option is true", () => {
    expect(renderWebhooksInterface([wh], { errors: true })).toContain(
      'errors: { "400": Schemas.BadRequest }',
    );
  });
  it("omits errors field when no error responses", () => {
    expect(renderWebhooksInterface([baseWebhook], { errors: true })).not.toContain("errors:");
  });
});
