import { describe, expect, it } from "vitest"
import { buildContract } from "../../../src/core/contract/build"

describe("contract: info and empties", () => {
  it("empty doc -> empty Contract", () => {
    const contract = buildContract({})
    expect(contract).toStrictEqual({ info: {}, schemas: [], operations: [] })
  })

  it("captures info fields", () => {
    const contract = buildContract({ info: { title: "T", version: "1.0", description: "D" } })
    expect(contract.info).toStrictEqual({ title: "T", version: "1.0", description: "D" })
  })
})
