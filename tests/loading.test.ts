import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { expect, it, vi } from "vitest"
import type { DocumentLoader, GenerateOptions } from "../src/core/index"
import { generate, GenerateError } from "../src/core/index"
import { oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"

const uri = "https://spec.test/api.json"
const document = oas("3.1")
const text = JSON.stringify(document)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function references(count: number) {
  return oas("3.1", {
    components: {
      schemas: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`T${i}`, { $ref: `./${i}.json` }]),
      ),
    },
  })
}

it("uses one loader for entry and external documents with absolute fragment-free URIs", async () => {
  const calls: string[] = []
  const result = await generate(`${uri}#ignored`, {
    load: (url, { signal }) => {
      calls.push(url)
      expect(signal).toBeInstanceOf(AbortSignal)
      return Response.json(url === uri ? references(1) : { type: "string" })
    },
  })
  expect(calls).toStrictEqual([uri, "https://spec.test/0.json"])
  expect(result.code).toContain("export type T0 = string")
})

it("delegates undefined to the file loader and parses custom YAML", async () => {
  await withFiles({ "api.json": text }, async (dir) => {
    const load = vi.fn<DocumentLoader>(() => undefined)
    const result = await generate(join(dir, "api.json"), { load })
    expect(result.diagnostics).toStrictEqual([])
    expect(load).toHaveBeenCalledOnce()
    expect(load.mock.calls[0]).toStrictEqual([
      expect.stringMatching(/^file:/),
      { signal: expect.any(AbortSignal) },
    ])
  })
  const result = await generate(uri, {
    load: () =>
      new Response("openapi: 3.1.2\ninfo: {title: YAML, version: '1'}", {
        headers: { "content-type": "application/yaml" },
      }),
  })
  expect(result.code).toContain("YAML")
})

it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid loading limits %s",
  async (limit) => {
    for (const key of ["maxConcurrentLoads", "maxDocumentBytes"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- independently verify both options
      await expect(generate(document, { [key]: limit })).rejects.toThrow(
        `${key} must be a positive safe integer`,
      )
    }
  },
)

it.each([undefined, 2])(
  "bounds concurrent reference loads to %s (default 8)",
  async (maxConcurrentLoads) => {
    const firstBatch = deferred<void>()
    const release = deferred<void>()
    let active = 0
    let peak = 0
    let calls = 0
    const limit = maxConcurrentLoads ?? 8
    const pending = generate(references(12), {
      base: uri,
      maxConcurrentLoads,
      load: async () => {
        calls++
        active++
        peak = Math.max(peak, active)
        if (active === limit) firstBatch.resolve()
        await release.promise
        active--
        return Response.json({ type: "string" })
      },
    })
    await firstBatch.promise
    expect(calls).toBe(limit)
    release.resolve()
    const result = await pending
    expect(result.diagnostics).toStrictEqual([])
    expect(calls).toBe(12)
    expect(peak).toBe(limit)
  },
)

it("registers documents in reference order despite completion order", async () => {
  const first = deferred<Response>()
  const second = deferred<void>()
  const ordered = oas("3.1", {
    components: {
      schemas: {
        T0: { $ref: "./0.json" },
        T1: { $ref: "./1.json" },
        Shared: { $ref: "https://spec.test/shared" },
      },
    },
  })
  const pending = generate(ordered, {
    base: uri,
    load: (url) => {
      if (url.endsWith("0.json")) return first.promise
      second.resolve()
      return Response.json({ $id: "https://spec.test/shared", type: "number" })
    },
  })
  await second.promise
  first.resolve(Response.json({ $id: "https://spec.test/shared", type: "string" }))
  const result = await pending
  // The shared resource resolves to the first claimant, even when it finishes last.
  expect(result.code).toContain("export type T0 = string")
  expect(result.code).toContain("export type T1 = number")
  expect(result.code).toContain("export type Shared = T0")
})

it("preserves a pre-aborted reason without starting retrieval", async () => {
  const reason = new RangeError("caller cancelled")
  const load = vi.fn<DocumentLoader>()
  await expect(generate(uri, { signal: AbortSignal.abort(reason), load })).rejects.toBe(reason)
  expect(load).not.toHaveBeenCalled()
})

it("cancels a loader that ignores its signal and disposes of its late response", async () => {
  const started = deferred<void>()
  const response = deferred<Response>()
  const cancelled = deferred<void>()
  const controller = new AbortController()
  const reason = { cancelled: true }
  const pending = generate(uri, {
    signal: controller.signal,
    load: () => {
      started.resolve()
      return response.promise
    },
  })
  const settled = pending.catch((error: unknown) => error)
  await started.promise
  controller.abort(reason)
  expect(await settled).toBe(reason)
  response.resolve(new Response(new ReadableStream({ cancel: () => cancelled.resolve() })))
  await cancelled.promise
})

it("cancels stalled streams and stops queued loads without waiting for cleanup", async () => {
  const started = deferred<void>()
  const cancelled = vi.fn<() => Promise<void>>(
    () =>
      new Promise<void>(() => {
        /* Intentionally uncooperative cleanup. */
      }),
  )
  const signals: AbortSignal[] = []
  const controller = new AbortController()
  const reason = new Error("stop")
  const pending = generate(references(5), {
    base: uri,
    signal: controller.signal,
    maxConcurrentLoads: 2,
    load: (_, { signal }) => {
      signals.push(signal)
      if (signals.length === 2) started.resolve()
      return new Response(new ReadableStream({ cancel: cancelled }))
    },
  })
  const settled = pending.catch((error: unknown) => error)
  await started.promise
  // Let both workers acquire their body readers.
  await Promise.resolve()
  controller.abort(reason)
  expect(await settled).toBe(reason)
  expect(signals).toHaveLength(2)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(cancelled).toHaveBeenCalledTimes(2)
})

it("observes cancellation between synchronous generation stages", async () => {
  const controller = new AbortController()
  const reason = new Error("between stages")
  const pending = generate(document, { signal: controller.signal })
  queueMicrotask(() => controller.abort(reason))
  await expect(pending).rejects.toBe(reason)
})

it("limits actual UTF-8 bytes, accepts the exact boundary, and cancels oversized streams", async () => {
  const serialized = JSON.stringify(oas("3.1", { info: { title: "文档", version: "1" } }))
  const bytes = new TextEncoder().encode(serialized)
  const result = await generate(uri, {
    maxDocumentBytes: bytes.length,
    load: () => new Response(bytes),
  })
  expect(result.diagnostics).toStrictEqual([])
  const cancelled = vi.fn<() => void>()
  const options: GenerateOptions = {
    maxDocumentBytes: bytes.length - 1,
    load: () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(bytes.slice(0, 20))
            stream.enqueue(bytes.slice(20))
          },
          cancel: cancelled,
        }),
        { headers: { "content-length": "1" } },
      ),
  }
  await expect(generate(uri, options)).rejects.toThrow(
    `Document is larger than ${bytes.length - 1} bytes; raise the limit with --max-document-size or maxDocumentBytes`,
  )
  expect(cancelled).toHaveBeenCalledOnce()
  await withFiles({ "api.json": serialized }, async (dir) => {
    await expect(
      generate(join(dir, "api.json"), { maxDocumentBytes: bytes.length - 1 }),
    ).rejects.toThrow("maxDocumentBytes")
  })
})

it("enforces the default 10 MiB limit and reports oversized references at their source", async () => {
  await expect(
    generate(uri, { load: () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)) }),
  ).rejects.toThrow("10485760 bytes")
  const failure = await generate(references(1), {
    base: uri,
    maxDocumentBytes: 1,
    load: () => Response.json({ type: "string" }),
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(GenerateError)
  expect((failure as GenerateError).diagnostics).toStrictEqual([
    expect.objectContaining({
      code: "unresolved-ref",
      location: "#/components/schemas/T0/$ref",
      message: expect.stringContaining("maxDocumentBytes"),
    }),
  ])
})

it("disposes of unsuccessful responses and reports hook failures", async () => {
  const cancelled = vi.fn<() => void>()
  await expect(
    generate(uri, {
      load: () => new Response(new ReadableStream({ cancel: cancelled }), { status: 403 }),
    }),
  ).rejects.toThrow("HTTP 403")
  expect(cancelled).toHaveBeenCalledOnce()
  await expect(
    generate(uri, {
      load: () => {
        throw new Error("credentials missing")
      },
    }),
  ).rejects.toThrow("credentials missing")
})

it("accepts any fetch implementation's Response, and rejects other loader results", async () => {
  // Another copy of undici, say, has its own Response class.
  const real = Response.json(document)
  const foreign = {
    ok: true,
    status: 200,
    statusText: "",
    url: "",
    headers: real.headers,
    body: real.body,
  }
  const result = await generate(uri, { load: () => foreign as unknown as Response })
  expect(result.diagnostics).toStrictEqual([])
  // Only undefined delegates: null must not reach the built-in loader.
  // A body that is not a web stream could not be cancelled, so a stalled one would hang.
  const stalled = { ok: true, headers: new Headers(), body: { getReader: () => ({}) } }
  for (const value of ["{}", null, { ...document, ok: true }, stalled]) {
    const load = (() => value) as unknown as DocumentLoader
    // oxlint-disable-next-line no-await-in-loop -- each result is checked on its own
    await expect(generate(uri, { load })).rejects.toThrow(
      "A document loader must return a Response or undefined",
    )
  }
})

it("disposes of a late loader result of any shape without an unhandled rejection", async () => {
  const late = deferred<unknown>()
  const controller = new AbortController()
  const reason = new Error("late")
  const pending = generate(uri, { signal: controller.signal, load: () => late.promise as never })
  const settled = pending.catch((error: unknown) => error)
  controller.abort(reason)
  expect(await settled).toBe(reason)
  const body = {
    get locked(): boolean {
      throw new Error("not a web stream")
    },
  }
  late.resolve({ ok: true, body })
  // Let the late result reach the disposal; a throw there would surface as an unhandled rejection.
  await new Promise((resolve) => {
    setImmediate(resolve)
  })
})

it("keeps retrieval boundaries ahead of custom loaders", async () => {
  const load = vi.fn<DocumentLoader>(() => Response.json({ type: "string" }))
  await expect(generate(references(1), { load })).rejects.toThrow()
  expect(load).not.toHaveBeenCalled()
  const remote = oas("3.1", {
    components: { schemas: { Secret: { $ref: "file:///private/secret.json" } } },
  })
  await expect(generate(remote, { base: uri, load })).rejects.toThrow()
  expect(load).not.toHaveBeenCalled()
})

it("times out custom loaders with the per-document deadline", async () => {
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
  const started = deferred<void>()
  try {
    const pending = generate(uri, {
      load: () => {
        started.resolve()
        return new Promise(() => {
          /* Intentionally uncooperative loader. */
        })
      },
    })
    const settled = pending.catch((error: unknown) => error)
    await started.promise
    expect(timeout).toHaveBeenCalledWith(30_000)
    deadline.abort(new Error("deadline expired"))
    expect(await settled).toMatchObject({ message: expect.stringContaining("deadline expired") })
  } finally {
    timeout.mockRestore()
  }
})

it("uses redirected response URLs as reference bases and counts decompressed HTTP bytes", async () => {
  const compressed = gzipSync(text)
  const server = createServer((request, response) => {
    if (request.url === "/api") {
      response.writeHead(302, { location: "/moved/entry.yaml" })
      response.end()
    } else if (request.url === "/moved/entry.yaml") {
      response.end(
        "openapi: 3.1.2\ninfo: {title: Redirected, version: '1'}\ncomponents: {schemas: {T: {$ref: './schema.json'}}}",
      )
    } else if (request.url === "/moved/schema.json") {
      response.end('{"type":"string"}')
    } else if (request.url === "/compressed") {
      response.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" })
      response.end(compressed)
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const custom = await generate(`${origin}/api`, {
      load: (url, { signal }) => fetch(url, { signal }),
    })
    expect(custom.code).toContain("export type T = string")
    const builtin = await generate(`${origin}/api`, { load: () => undefined })
    expect(builtin.code).toBe(custom.code)
    await expect(
      generate(`${origin}/compressed`, {
        maxDocumentBytes: new TextEncoder().encode(text).length - 1,
      }),
    ).rejects.toThrow("maxDocumentBytes")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})

it("rejects a custom remote response that claims a local retrieval URL", async () => {
  const response = Response.json(document)
  Object.defineProperty(response, "url", { value: "file:///private/secret.json" })
  await expect(generate(uri, { load: () => response })).rejects.toThrow("Cannot redirect")
})

it.each(["caller", "deadline"] as const)(
  "observes %s cancellation during a flood of synchronous empty chunks",
  async (source) => {
    const controller = new AbortController()
    const reason = new Error("empty chunk flood cancelled")
    const timeout =
      source === "deadline"
        ? vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
        : undefined
    const cancelled = vi.fn<() => void>()
    let reads = 0
    // A finite flood makes a reader that never yields fail rather than hang the test runner.
    const timer = setImmediate(() => controller.abort(reason))
    try {
      const pending = generate(uri, {
        signal: source === "caller" ? controller.signal : undefined,
        maxDocumentBytes: 1,
        load: () =>
          new Response(
            new ReadableStream({
              pull(stream) {
                if (++reads === 1024) stream.close()
                else stream.enqueue(new Uint8Array(0))
              },
              cancel: cancelled,
            }),
          ),
      })
      const failure = await pending.catch((error: unknown) => error)
      expect(failure).toMatchObject({ message: expect.stringContaining(reason.message) })
      expect(source !== "caller" || failure === reason).toBe(true)
      expect(reads).toBeLessThan(1024)
      expect(cancelled).toHaveBeenCalledOnce()
    } finally {
      clearImmediate(timer)
      timeout?.mockRestore()
    }
  },
)

it("retains split UTF-8 characters across stream yields and empty decoder output", async () => {
  const title = "分块文档".repeat(40)
  const bytes = new TextEncoder().encode(
    JSON.stringify(oas("3.1", { info: { title, version: "1" } })),
  )
  let position = 0
  const result = await generate(uri, {
    maxDocumentBytes: bytes.length,
    load: () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            if (position === bytes.length) stream.close()
            else stream.enqueue(bytes.slice(position, ++position))
          },
        }),
      ),
  })
  expect(result.code).toContain(title)
})
