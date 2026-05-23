import { describe, expect, it } from "vitest"
import type { EndpointOperation } from "../../../src/core/contract/contract"
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

  it("emits single-line @summary when only summary is set", () => {
    expect(entryDocHeader({ ...base, summary: "List pets" })).toBe("  /** @summary List pets */\n")
  })

  it("emits single-line @deprecated when only deprecated is true", () => {
    expect(entryDocHeader({ ...base, deprecated: true })).toBe("  /** @deprecated */\n")
  })

  it("emits multi-line block when summary and deprecated combine", () => {
    expect(entryDocHeader({ ...base, summary: "List pets", deprecated: true })).toBe(
      "  /**\n   * @summary List pets\n   * @deprecated\n   */\n",
    )
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
