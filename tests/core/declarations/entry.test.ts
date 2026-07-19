import { describe, expect, it } from "vitest"
import type { EndpointOperation } from "../../../src/core/contract/model"
import { entryDocHeader } from "../../../src/core/declarations/entry"

const base: EndpointOperation = {
  kind: "endpoint",
  key: "GET /pets",
  method: "get",
  path: "/pets",
  tags: [],
  deprecated: false,
  params: [],
  query: [],
  headers: [],
  body: { kind: "none" },
  responses: [],
}

describe("entryDocHeader", () => {
  it("returns empty string when no summary/description/deprecated", () => {
    expect(entryDocHeader(base)).toBe("")
  })

  it("emits @summary + @description + @deprecated together", () => {
    expect(
      entryDocHeader({
        ...base,
        summary: "List pets",
        description: "Returns all pets.",
        deprecated: true,
      }),
    ).toBe(
      "  /**\n   * @summary List pets\n   * @description Returns all pets.\n   * @deprecated\n   */\n",
    )
  })
})
