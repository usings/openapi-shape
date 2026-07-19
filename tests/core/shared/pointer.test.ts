import { describe, expect, it } from "vitest"
import {
  appendPointer,
  decodePointerSegment,
  escapePointerSegment,
  pointer,
} from "../../../src/core/shared/pointer"

describe("JSON Pointer helpers", () => {
  it("escapes and decodes one segment", () => {
    expect(escapePointerSegment("a~/b")).toBe("a~0~1b")
    expect(decodePointerSegment("a~0~1b")).toBe("a~/b")
  })

  it("builds escaped pointer paths", () => {
    expect(pointer("paths", "/pets", "get")).toBe("/paths/~1pets/get")
    expect(appendPointer("/paths/~1pets/get", "responses", 200)).toBe(
      "/paths/~1pets/get/responses/200",
    )
  })
})
