import { decodeBody } from "./body"
import type { Contract, EndpointContract } from "./contract"
import { CONTRACT_VERSION } from "./contract"
import type { CallInit, RequestDefaults } from "./request"
import { buildRequest } from "./request"
import type { StreamOptions } from "./stream"
import { stream as subscribe } from "./stream"
import type {
  Endpoint,
  EndpointArgs,
  EndpointResult,
  MethodOf,
  OperationOf,
  ResponseOf,
  ResultEndpoint,
  StreamArgs,
  StreamEndpoint,
} from "./types"

export type { Contract } from "./contract"
export type {
  Endpoint,
  EndpointArgs,
  EndpointData,
  EndpointMessage,
  ResultEndpoint,
  StreamArgs,
  StreamEndpoint,
  TypedResponse,
} from "./types"
export type { StreamMessage, StreamOptions } from "./stream"
export { StreamResponseError } from "./stream"

/**
 * Defaults for every request: any `RequestInit` field but `signal`, which every request would share
 * (a timeout would run out for all of them at once), plus where and how requests are sent.
 */
export interface ClientOptions extends Omit<RequestInit, "method" | "body" | "signal"> {
  /** Prefix for endpoint paths, such as `https://api.example.com/v1`. Without it, URLs are relative. */
  baseUrl?: string | URL
  /** Wraps the sending of every request, the first outermost. */
  middleware?: readonly Middleware[]
  /** Sends each request, after the last middleware. Default: the global `fetch`. */
  fetch?: Fetcher
}

/** Sends a request and resolves to its response, as `fetch` does. */
export type Fetcher = (request: Request) => Promise<Response>

/**
 * Wraps the sending of a request: takes it and `next`, which sends a request on through the rest,
 * and resolves to a response. It may pass on another request, call `next` again, or answer without
 * calling it. The request is the very one the middleware around it passed on, so a change is made
 * to a copy, `new Request(request)`, out of that middleware's sight.
 */
export type Middleware = (request: Request, next: Fetcher) => Promise<Response>

/** A middleware, typed where it is written; returned as it is. */
export function defineMiddleware<T extends Middleware>(middleware: T): T {
  return middleware
}

/** A typed `fetch` for the generated `Endpoints`: each call names one endpoint, `"METHOD /path"`. */
export interface Client<Endpoints> {
  // Infer the supplied string before checking membership, so an unknown endpoint
  // does not fall back to the endpoint union and report a missing init argument.
  /** Send the request; resolve to its response, typed by status, whatever the status. */
  fetch<K extends string>(
    endpoint: K & Endpoint<Endpoints>,
    ...init: EndpointArgs<Endpoints, K & Endpoint<Endpoints>>
  ): Promise<
    ResponseOf<OperationOf<Endpoints, K & Endpoint<Endpoints>>, MethodOf<K & Endpoint<Endpoints>>>
  >
  /**
   * Send the request and read its body, decoded: `data` for a 2xx status, `error` for any other
   * (`null` when there is none), never both; `status` narrows them by status.
   */
  result<K extends string>(
    endpoint: K & ResultEndpoint<Endpoints>,
    ...init: EndpointArgs<Endpoints, K & ResultEndpoint<Endpoints>>
  ): Promise<EndpointResult<Endpoints, K & ResultEndpoint<Endpoints>>>
  /** Consume SSE events until EOF or cancellation; reconnect on transient failures. */
  stream<K extends string>(
    endpoint: K & StreamEndpoint<Endpoints>,
    ...init: StreamArgs<Endpoints, K & StreamEndpoint<Endpoints>>
  ): Promise<void>
}

/** Create a typed `fetch` from a generated module's `contract`. */
export function createClient<Endpoints>(
  contract: Contract<Endpoints>,
  options: ClientOptions = {},
): Client<Endpoints> {
  if (
    contract?.version !== CONTRACT_VERSION ||
    contract.endpoints === null ||
    typeof contract.endpoints !== "object"
  ) {
    throw new TypeError(
      `createClient takes a generated contract of format ${CONTRACT_VERSION} as its first argument; regenerate the module with this version of openapi-shape`,
    )
  }
  const { baseUrl, middleware = [], fetch: transport, headers, ...init } = options
  const prefix = baseUrl === undefined ? "" : String(baseUrl).replace(/\/+$/, "")
  // Endpoint paths go after it, so a query or fragment would swallow them.
  if (/[?#]/.test(prefix)) throw new TypeError(`baseUrl "${prefix}" has a query or fragment`)
  const defaults: RequestDefaults = {
    endpoints: contract.endpoints as Readonly<Record<string, EndpointContract | undefined>>,
    prefix,
    headers,
    init,
  }
  // Called unbound: a browser's `fetch` refuses to be called on another object.
  // Each step is async, so that what throws inside rejects the `next` around it.
  const transmit: Fetcher = async (request) => await (transport ?? globalThis.fetch)(request)
  // The first middleware is the outermost.
  const send = middleware.reduceRight<Fetcher>(
    (next, wrap) => async (request) => await wrap(request, next),
    transmit,
  )

  // Async, so that a request that cannot be built rejects.
  const fetch = async (endpoint: string, call: CallInit = {}): Promise<Response> =>
    await send(buildRequest(endpoint, call, defaults))

  // The body is always read, so that the connection is free again.
  const result = async (endpoint: string, call: CallInit = {}): Promise<unknown> => {
    if (defaults.endpoints[endpoint]?.stream === "sse") {
      throw new TypeError(`Endpoint "${endpoint}" requires api.stream() or api.fetch()`)
    }
    const request = buildRequest(endpoint, call, defaults)
    const response = await send(request)
    const body = await decodeBody(response, request.method)
    // A failure's error is never undefined, which is what tells a success.
    const { status } = response
    return response.ok
      ? { data: body, error: undefined, status, response }
      : { data: undefined, error: body ?? null, status, response }
  }

  const stream = async (endpoint: string, call: CallInit & StreamOptions = {}): Promise<void> => {
    await subscribe(endpoint, call, defaults, send)
  }

  return { fetch, result, stream } as unknown as Client<Endpoints>
}
