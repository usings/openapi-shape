import { describe, expect, it, vi } from "vitest"
import type { Fetcher, Middleware, MiddlewareContext } from "../../src/client"
import { createClient, defineMiddleware } from "../../src/client"
import { contract } from "../fixtures/output/client-api"
import { recorder } from "../support/client"

/** A middleware, or a `fetch` option, that throws as it is called. */
function refuse(): never {
  throw new Error("no token")
}

describe("middleware", () => {
  it("snapshots the chain and isolates contexts across concurrent client methods", async () => {
    const ready = Promise.withResolvers<void>()
    const seen: MiddlewareContext[] = []
    const observe: Middleware = async (request, next, context) => {
      const received = await next(request)
      expect(Object.isFrozen(context)).toBe(true)
      seen.push(context)
      return received
    }
    const middleware = [observe]
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware,
      fetch: async (request) => {
        await ready.promise
        return request.url.endsWith("/events")
          ? new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } })
          : Response.json({ id: 1, name: "Milo" })
      },
    })
    middleware[0] = () => Promise.reject(new Error("changed configuration"))
    const fetched = api.fetch("GET /pets/{id}", { params: { id: 1 } })
    const result = api.result("GET /pets/{id}", { params: { id: 2 } })
    const reader = api.stream("GET /events", { reconnect: false }).getReader()
    const reading = reader.read()
    ready.resolve()
    await Promise.all([fetched, result, reading])
    expect(seen.toSorted((a, b) => a.kind.localeCompare(b.kind))).toStrictEqual([
      { endpoint: "GET /pets/{id}", kind: "fetch" },
      { endpoint: "GET /pets/{id}", kind: "result" },
      { endpoint: "GET /events", kind: "stream" },
    ])
    const fetchedResponse = await fetched
    await fetchedResponse.body?.cancel()
    await reader.cancel()
  })

  it.each(["fetch", "result"] as const)(
    "lets middleware dispose its response before throwing in %s",
    async (kind) => {
      const failure = new Error("after response")
      const cancel = vi.fn<() => void>()
      const api = createClient(contract, {
        baseURL: "https://api.test",
        middleware: [
          async (request, next) => {
            const received = await next(request)
            await received.body?.cancel()
            throw failure
          },
        ],
        fetch: () => Promise.resolve(new Response(new ReadableStream({ cancel }))),
      })
      await expect(api[kind]("GET /pets")).rejects.toBe(failure)
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(["fetch", "result"] as const)(
    "lets each middleware retire its own replaced response in %s",
    async (kind) => {
      const transportCancel = vi.fn<() => void>()
      const middleCancel = vi.fn<() => void>()
      const selected = Response.json({ id: 1, name: "Milo" })
      const api = createClient(contract, {
        baseURL: "https://api.test",
        middleware: [
          async (request, next) => {
            const received = await next(request)
            await received.body?.cancel()
            return selected
          },
          async (request, next) => {
            const received = await next(request)
            await received.body?.cancel()
            return new Response(new ReadableStream({ cancel: middleCancel }))
          },
        ],
        fetch: () => Promise.resolve(new Response(new ReadableStream({ cancel: transportCancel }))),
      })
      const answer = await api[kind]("GET /pets/{id}", { params: { id: 1 } })
      expect(transportCancel).toHaveBeenCalledOnce()
      expect(middleCancel).toHaveBeenCalledOnce()
      const data = answer instanceof Response ? await answer.json() : answer.data
      expect(data).toStrictEqual({ id: 1, name: "Milo" })
    },
  )

  it("keeps a selected response body alive when middleware wraps the same stream", async () => {
    const original = new Response('"kept"', { headers: { "content-type": "application/json" } })
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware: [
        async (request, next) => {
          const received = await next(request)
          return new Response(received.body)
        },
      ],
      fetch: () => Promise.resolve(original),
    })
    const selected = await api.fetch("GET /pets")
    expect(selected.body).toBe(original.body)
    expect(await selected.json()).toBe("kept")
  })

  it("delivers a late next response to its middleware owner", async () => {
    const pending = Promise.withResolvers<Response>()
    const cancel = vi.fn<() => void>()
    let late: Promise<Response> | undefined
    let attempts = 0
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware: [
        (request, next) => {
          const selected = next(request.clone())
          late = next(request)
          return selected
        },
      ],
      fetch: () =>
        ++attempts === 1 ? Promise.resolve(Response.json("selected")) : pending.promise,
    })
    const selected = await api.fetch("GET /pets")
    pending.resolve(new Response(new ReadableStream({ cancel })))
    const received = await late
    expect(cancel).not.toHaveBeenCalled()
    await received?.body?.cancel()
    expect(cancel).toHaveBeenCalledOnce()
    expect(await selected.json()).toBe("selected")
  })

  it.each(["fetch", "result"] as const)(
    "aborts pending %s middleware and retires its late transport response",
    async (kind) => {
      const pending = Promise.withResolvers<Response>()
      const started = Promise.withResolvers<void>()
      const canceled = Promise.withResolvers<void>()
      const abort = new AbortController()
      const failure = { reason: "stop" }
      const api = createClient(contract, {
        baseURL: "https://api.test",
        fetch: () => {
          started.resolve()
          return pending.promise
        },
      })
      const result = api[kind]("GET /pets", { signal: abort.signal }).catch(
        (error: unknown) => error,
      )
      await started.promise
      abort.abort(failure)
      expect(await result).toBe(failure)
      pending.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              canceled.resolve()
            },
          }),
        ),
      )
      await canceled.promise
    },
  )

  it("blocks a retained next after cancellation even if its request replaces the signal", async () => {
    const fetch = vi.fn<Fetcher>()
    const abort = new AbortController()
    let resume: Fetcher | undefined
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware: [
        (_request, next) => {
          resume = next
          return Promise.resolve(Response.json([]))
        },
      ],
      fetch,
    })
    const selected = await api.fetch("GET /pets", { signal: abort.signal })
    const failure = new Error("finished")
    abort.abort(failure)
    await expect(resume?.(new Request("https://api.test/pets"))).rejects.toBe(failure)
    expect(fetch).not.toHaveBeenCalled()
    await selected.body?.cancel()
  })

  it("leaves result decoding outside the HTTP middleware error boundary", async () => {
    const caught = vi.fn<() => void>()
    const api = createClient(contract, {
      baseURL: "https://api.test",
      middleware: [
        async (request, next) => {
          try {
            return await next(request)
          } catch (error) {
            caught()
            throw error
          }
        },
      ],
      fetch: () =>
        Promise.resolve(new Response("{bad}", { headers: { "content-type": "application/json" } })),
    })
    await expect(api.result("GET /pets")).rejects.toMatchObject({ name: "SyntaxError" })
    expect(caught).not.toHaveBeenCalled()
  })

  it("wraps sending, the first outermost, with the fetch option after the last", async () => {
    const answered: string[] = []
    const via = (name: string): Middleware =>
      defineMiddleware(async (request, next) => {
        request.headers.append("x-via", name)
        const response = await next(request)
        answered.push(name)
        return response
      })
    const { client, sent } = recorder(contract, { middleware: [via("outer"), via("inner")] })
    await client.fetch("GET /pets")
    expect(sent().headers.get("x-via")).toBe("outer, inner")
    expect(answered).toStrictEqual(["inner", "outer"])
  })

  it("sends what a middleware passes on, and again each time it calls next", async () => {
    let tries = 0
    const passed: string[] = []
    const { client, requests } = recorder(
      contract,
      {
        middleware: [
          // A reconnect: the second try sends the request the first one did not use up.
          async (request, next) => {
            const first = await next(request.clone())
            if (first.status !== 503) return first
            await first.body?.cancel()
            return next(request)
          },
          (request, next) => {
            passed.push(request.method)
            return next(new Request(request, { headers: { "x-try": String(passed.length) } }))
          },
        ],
      },
      () => new Response(null, { status: ++tries === 1 ? 503 : 204 }),
    )
    const response = await client.fetch("GET /pets")
    expect(response.status).toBe(204)
    expect(passed).toStrictEqual(["GET", "GET"])
    expect(requests.map((request) => request.headers.get("x-try"))).toStrictEqual(["1", "2"])
  })

  it("reads the body of the response the middleware pass on", async () => {
    const seen: unknown[] = []
    const { client } = recorder(
      contract,
      {
        middleware: [
          async (request, next) => {
            const response = await next(request)
            seen.push(await response.clone().json())
            return response
          },
        ],
      },
      () => Response.json({ id: 1, name: "Rex" }),
    )
    const { data } = await client.result("GET /pets/{id}", { params: { id: 1 } })
    expect(data).toStrictEqual({ id: 1, name: "Rex" })
    expect(seen).toStrictEqual([data])
  })

  it("takes a middleware's own answer, sending nothing", async () => {
    const { client, requests } = recorder(contract, {
      middleware: [() => Promise.resolve(Response.json({ id: 1, name: "Rex" }))],
    })
    const { data } = await client.result("GET /pets/{id}", { params: { id: 1 } })
    expect(data).toStrictEqual({ id: 1, name: "Rex" })
    expect(requests).toStrictEqual([])
  })

  it("rejects what a middleware throws", async () => {
    const { client } = recorder(contract, { middleware: [refuse] })
    await expect(client.fetch("GET /pets")).rejects.toThrow("no token")
    await expect(client.result("GET /pets")).rejects.toThrow("no token")
  })

  it("rejects next, never throws from it, whatever throws inside", async () => {
    const fallback = defineMiddleware((request, next) =>
      next(request).catch(() => new Response(null, { status: 503 })),
    )
    for (const options of [
      { middleware: [fallback, refuse] },
      { middleware: [fallback], fetch: refuse },
    ]) {
      const client = createClient(contract, { baseURL: "https://x.test", ...options })
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      const response = await client.fetch("GET /pets")
      expect(response.status).toBe(503)
    }
  })
})

it("preserves a middleware function and its attached metadata", () => {
  const auth = Object.assign((request: Request, next: Fetcher) => next(request), { label: "auth" })
  expect(defineMiddleware(auth)).toBe(auth)
  expect(defineMiddleware(auth).label).toBe("auth")
})
