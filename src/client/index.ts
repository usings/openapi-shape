import type { Contract, EndpointContract } from "../shared/contract"
import { CONTRACT_VERSION } from "../shared/contract"
import { decodeBody } from "./body"
import type { Fetcher, Middleware } from "./middleware"
import { createSender } from "./middleware"
import type { CallInit, RequestDefaults } from "./request"
import { buildRequest, normalizeBaseURL } from "./request"
import { stream as subscribe } from "./stream"
import type {
  Endpoint,
  EndpointArgs,
  EndpointResult,
  EndpointStreamItem,
  ResponseOf,
  ResultEndpoint,
  StreamArgs,
  StreamEndpoint,
  StreamMedia,
  StreamOptions,
} from "./types"

export type { Contract } from "../shared/contract"
export type { Fetcher, Middleware, MiddlewareContext } from "./middleware"
export { defineMiddleware } from "./middleware"
export type {
  Endpoint,
  EndpointArgs,
  EndpointData,
  EndpointMessage,
  EndpointStreamItem,
  ResultEndpoint,
  StreamArgs,
  StreamEndpoint,
  StreamMedia,
  StreamOptions,
  StreamRetryOptions,
  TypedResponse,
} from "./types"
export type { StreamMessage } from "./sse-parser"
export { StreamParseError } from "./jsonl-parser"
export { StreamResponseError } from "./stream"

/**
 * Defaults for every request: any `RequestInit` field but `signal`, which every request would share
 * (a timeout would run out for all of them at once), plus where and how requests are sent.
 */
export interface ClientOptions extends Omit<RequestInit, "method" | "body" | "signal"> {
  /** Default prefix for endpoint paths; each call can override it. Without it, URLs are relative. */
  baseURL?: string | URL | undefined
  /** Wraps the sending of every request, the first outermost. */
  middleware?: readonly Middleware[]
  /** Sends each request, after the last middleware. Default: the global `fetch`. */
  fetch?: Fetcher
}

/** A typed `fetch` for the generated `Endpoints`: each call names one endpoint, `"METHOD /path"`. */
export interface Client<Endpoints> {
  // Infer the supplied string before checking membership, so an unknown endpoint
  // does not fall back to the endpoint union and report a missing init argument.
  /** Send the request; resolve to its response, typed by status, whatever the status. */
  fetch<K extends string>(
    endpoint: K & Endpoint<Endpoints>,
    ...init: EndpointArgs<Endpoints, K & Endpoint<Endpoints>>
  ): Promise<ResponseOf<Endpoints, K & Endpoint<Endpoints>>>
  /**
   * Send the request and read its body, decoded: `data` for a 2xx status, `error` for any other
   * (`null` when there is none), never both; `status` narrows them by status.
   */
  result<K extends string>(
    endpoint: K & ResultEndpoint<Endpoints>,
    ...init: EndpointArgs<Endpoints, K & ResultEndpoint<Endpoints>>
  ): Promise<EndpointResult<Endpoints, K & ResultEndpoint<Endpoints>>>
  /** Read typed SSE messages or JSON records on demand; SSE may reconnect within the same stream. */
  stream<
    K extends StreamEndpoint<Endpoints>,
    const M extends StreamMedia<Endpoints, K> = StreamMedia<Endpoints, K>,
  >(
    endpoint: K,
    ...init: StreamArgs<Endpoints, K, M>
  ): ReadableStream<EndpointStreamItem<Endpoints, K, M>>
}

/** Create a typed `fetch` from a generated module's `contract`. */
export function createClient<Endpoints>(
  contract: Contract<Endpoints>,
  options: ClientOptions = {},
): Client<Endpoints> {
  if (
    contract?.version !== CONTRACT_VERSION ||
    contract.endpoints === null ||
    typeof contract.endpoints !== "object" ||
    Array.isArray(contract.endpoints)
  ) {
    throw new TypeError(`regenerate the module with this version of openapi-shape`)
  }
  const { baseURL, middleware = [], fetch: transport, headers, ...init } = options
  const prefix = normalizeBaseURL(baseURL)
  const defaults: RequestDefaults = {
    endpoints: contract.endpoints as Readonly<Record<string, EndpointContract | undefined>>,
    prefix,
    headers,
    init,
  }
  const send = createSender(middleware, transport)

  // Async, so that a request that cannot be built rejects.
  const fetch = async (endpoint: string, call: CallInit = {}): Promise<Response> =>
    await send(buildRequest(endpoint, call, defaults), { endpoint, kind: "fetch" })

  // The body is always read, so that the connection is free again.
  const result = async (endpoint: string, call: CallInit = {}): Promise<unknown> => {
    if (Object.hasOwn(defaults.endpoints, endpoint) && defaults.endpoints[endpoint]?.stream) {
      throw new TypeError(`Endpoint "${endpoint}" requires api.stream() or api.fetch()`)
    }
    const request = buildRequest(endpoint, call, defaults)
    const response = await send(request, { endpoint, kind: "result" })
    const body = await decodeBody(response, request.method, request.signal)
    // A failure's error is never undefined, which is what tells a success.
    const { status } = response
    return response.ok
      ? { data: body, error: undefined, status, response }
      : { data: undefined, error: body ?? null, status, response }
  }

  const stream = (endpoint: string, call: CallInit & StreamOptions = {}): ReadableStream<unknown> =>
    subscribe(endpoint, call, defaults, send)

  return { fetch, result, stream } as unknown as Client<Endpoints>
}
