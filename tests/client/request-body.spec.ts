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

it.each(["GET", "HEAD", "invalid URL"])(
  "does not acquire an iterator when Request construction fails for %s",
  async (failure) => {
    const { buildRequest } = await import("../../src/client/request")
    const acquire = vi.fn<() => AsyncIterator<Uint8Array>>(() => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }))
    const method = failure === "invalid URL" ? "POST" : failure
    const endpoint = `${method} /upload`
    expect(() =>
      buildRequest(
        endpoint,
        { body: { [Symbol.asyncIterator]: acquire } },
        {
          endpoints: { [endpoint]: { responses: {} } },
          prefix: failure === "invalid URL" ? "invalid" : "https://example.test",
          headers: undefined,
          init: {},
        },
      ),
    ).toThrow(TypeError)
    expect(acquire).not.toHaveBeenCalled()
  },
)

it.each(["resolve", "reject", "throw", "pending"])(
  "releases a failing upload iterator without replacing or delaying the read error when cleanup is %s",
  async (cleanup) => {
    const failure = new Error("read failed")
    const close = vi.fn<() => Promise<IteratorResult<Uint8Array>>>(() => {
      if (cleanup === "throw") throw new Error("synchronous cleanup failure")
      if (cleanup === "reject") return Promise.reject(new Error("cleanup failed"))
      if (cleanup === "pending")
        return new Promise(() => {
          /* Cleanup never settles. */
        })
      return Promise.resolve({ done: true, value: undefined })
    })
    const iterator: AsyncIterator<Uint8Array> = {
      next() {
        if (cleanup === "throw") throw failure
        return Promise.reject(failure)
      },
      return: close,
    }
    const encoded = encodeBody(
      { [Symbol.asyncIterator]: () => iterator },
      "application/octet-stream",
    ).body
    if (!(encoded instanceof ReadableStream)) throw new Error("Expected an adapted Web stream")
    const reader = encoded.getReader()
    try {
      await expect(reader.read()).rejects.toBe(failure)
      expect(close).toHaveBeenCalledOnce()
    } finally {
      reader.releaseLock()
    }
  },
)
