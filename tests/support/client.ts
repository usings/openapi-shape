import type { Client, ClientOptions, Contract } from "../../src/client"
import { createClient } from "../../src/client"

/**
 * A client whose `fetch` records each request and answers with `respond()`; `sent()` is the last
 * request. Endpoint paths go under `https://x.test`.
 */
export function recorder<Api>(
  given: Contract<Api>,
  options: Omit<ClientOptions, "fetch"> = {},
  respond: () => Response = () => new Response(null, { status: 204 }),
): { client: Client<Api, never>; sent: () => Request; requests: Request[] } {
  const requests: Request[] = []
  const client = createClient(given, {
    baseURL: "https://x.test",
    ...options,
    fetch: (request) => {
      requests.push(request)
      return Promise.resolve(respond())
    },
  })
  const sent = (): Request => {
    const last = requests.at(-1)
    if (last === undefined) throw new Error("Nothing was sent")
    return last
  }
  return { client, sent, requests }
}

/** A request's URL under `https://x.test`. */
export function url(request: Request): string {
  return request.url.slice("https://x.test".length)
}

/** A `SharedArrayBuffer` holding these bytes. */
export function shared(values: number[]): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(values.length)
  new Uint8Array(buffer).set(values)
  return buffer
}
