import { describe, expect, it } from "vitest"
import type { CallbackOperation } from "../../../src/core/contract/model"
import { renderCallbacksInterface } from "../../../src/core/declarations/callback"

const callback: CallbackOperation = {
  kind: "callback",
  key: "POST /subscribe > onEvent > POST {$request.body#/callbackUrl}",
  parentKey: "POST /subscribe",
  callbackName: "onEvent",
  expression: "{$request.body#/callbackUrl}",
  method: "post",
  tags: [],
  deprecated: false,
  params: [],
  query: [],
  headers: [],
  cookies: [],
  body: { kind: "none" },
  responses: [],
}

describe("renderCallbacksInterface", () => {
  it("uses receiving-side payload and reply vocabulary", () => {
    expect(renderCallbacksInterface([callback])).toBe(
      `export interface Callbacks {\n  "POST /subscribe > onEvent > POST {$request.body#/callbackUrl}": {\n    params: void\n    query: void\n    payload: void\n    reply: unknown\n  }\n}`,
    )
  })

  it("renders callback path parameters", () => {
    const out = renderCallbacksInterface([
      {
        ...callback,
        params: [{ name: "petId", required: true, type: { kind: "scalar", name: "string" } }],
      },
    ])
    expect(out).toContain("params: { petId: string }")
  })

  it("renders typed headers when enabled", () => {
    const out = renderCallbacksInterface(
      [
        {
          ...callback,
          headers: [
            { name: "X-Signature", required: true, type: { kind: "scalar", name: "string" } },
          ],
        },
      ],
      { headers: true },
    )
    expect(out).toContain('headers: { "X-Signature": string }')
  })
})
