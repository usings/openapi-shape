import { expect, it, vi } from "vitest"
import { encodeBody, isReadyBody } from "../../src/client/request-body"

it("recognizes shared byte bodies without allocating a conversion, then snapshots them for sending", () => {
  const shared = new SharedArrayBuffer(4)
  const bytes = new Uint8Array(shared)
  bytes.set([1, 2, 3, 4])
  const allocate = vi.spyOn(globalThis, "Uint8Array")
  try {
    expect(isReadyBody(shared)).toBe(true)
    expect(isReadyBody(bytes.subarray(1, 3))).toBe(true)
    expect(allocate).not.toHaveBeenCalled()
  } finally {
    allocate.mockRestore()
  }
  const encoded = encodeBody(bytes.subarray(1, 3), "application/octet-stream").body
  expect(encoded).toBeInstanceOf(Uint8Array)
  expect([...(encoded as Uint8Array)]).toStrictEqual([2, 3])
  bytes.fill(9)
  expect([...(encoded as Uint8Array)]).toStrictEqual([2, 3])
})
