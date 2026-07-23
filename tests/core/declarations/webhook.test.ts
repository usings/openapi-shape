import { describe, expect, it } from "vitest"
import type { WebhookOperation } from "../../../src/core/contract/model"
import { renderWebhooksInterface } from "../../../src/core/declarations/webhook"

const webhook: WebhookOperation = {
  kind: "webhook",
  key: "POST pet.created",
  method: "post",
  name: "pet.created",
  tags: [],
  deprecated: false,
  query: [],
  headers: [],
  cookies: [],
  body: { kind: "none" },
  responses: [],
}

describe("renderWebhooksInterface", () => {
  it("omits params and uses receiving-side payload and reply vocabulary", () => {
    expect(renderWebhooksInterface([webhook])).toBe(
      `export interface Webhooks {\n  "POST pet.created": {\n    query: void\n    payload: void\n    reply: unknown\n  }\n}`,
    )
  })

  it("preserves optional payloads and typed replies", () => {
    const out = renderWebhooksInterface([
      {
        ...webhook,
        body: { kind: "json", required: false, type: { kind: "scalar", name: "string" } },
        responses: [{ status: "200", type: { kind: "scalar", name: "boolean" } }],
      },
    ])
    expect(out).toContain("payload?: string")
    expect(out).toContain('reply: { "200": boolean }')
    expect(out).not.toContain("params:")
  })
})
