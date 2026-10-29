import type { Contract, EndpointContract } from "../shared/contract"
import { CONTRACT_VERSION } from "../shared/contract"
import type { Fetcher, Middleware } from "./middleware"
import { createSender } from "./middleware"
import type { CallInit, RequestDefaults } from "./request"
import { buildRequest, normalizeBaseURL } from "./request"
import { readResult } from "./response"
import { stream as subscribe } from "./streams/subscription"
import type {
  Endpoint,
  EndpointArgs,
  EndpointResult,
  EndpointStreamItem,
  NegotiatedStreamArgs,
  ResponseOf,
  ResultEndpoint,
  StreamArgs,
  StreamEndpoint,
  StreamMedia,
  StreamOptions,
} from "./types"
import type { DefaultMedia, HeaderArgs, LowercaseHeaders } from "./types/headers"

export type { Contract } from "../shared/contract"
export { defineMiddleware } from "./middleware"
export type { Fetcher, Middleware, MiddlewareContext } from "./middleware"
export { ContractResponseError } from "./response"
export { StreamParseError } from "./streams/jsonl-parser"
export { StreamMessageTooLargeError } from "./streams/message-buffer"
export type { StreamMessage } from "./streams/sse-parser"
export { StreamResponseError } from "./streams/subscription"
export type {
  Endpoint,
  EndpointArgs,
  EndpointData,
  EndpointMessage,
  EndpointStreamItem,
  NegotiatedStreamArgs,
  ResultEndpoint,
  StreamArgs,
  StreamEndpoint,
  StreamMedia,
  StreamOptions,
  StreamRetryOptions,
  TypedHeaders,
  TypedResponse,
} from "./types"

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
export interface Client<Endpoints, D extends string = "application/json"> {
  // Infer the supplied string before checking membership, so an unknown endpoint
  // does not fall back to the endpoint union and report a missing init argument.
  /** Send the request; resolve to its response, typed by status, whatever the status. */
  fetch<K extends string, const H extends object = object>(
    endpoint: K & Endpoint<Endpoints>,
    ...init:
      | (EndpointArgs<Endpoints, K & Endpoint<Endpoints>, D, H> &
          [init?: { headers?: H | undefined } | undefined])
      | [init: never]
  ): Promise<ResponseOf<Endpoints, K & Endpoint<Endpoints>>>
  /**
   * Send the request and read its body, decoded: `data` for a 2xx status, `error` for any other
   * (`null` when there is none), never both; `status` narrows them by status.
   */
  result<K extends string, const H extends object = object>(
    endpoint: K & ResultEndpoint<Endpoints>,
    ...init:
      | (EndpointArgs<Endpoints, K & ResultEndpoint<Endpoints>, D, H> &
          [init?: { headers?: H | undefined } | undefined])
      | [init: never]
  ): Promise<EndpointResult<Endpoints, K & ResultEndpoint<Endpoints>>>
  /** Read typed SSE messages or JSON records on demand; SSE may reconnect within the same stream. */
  stream<
    K extends StreamEndpoint<Endpoints>,
    const M extends StreamMedia<Endpoints, K> = StreamMedia<Endpoints, K>,
    const H extends object = object,
  >(
    endpoint: K,
    ...init: HeaderArgs<StreamArgs<Endpoints, K, M, D>, H> &
      [init?: { headers?: H | undefined } | undefined]
  ): ReadableStream<EndpointStreamItem<Endpoints, K, SelectedStreamMedia<Endpoints, K, M, H>>>
  stream<K extends StreamEndpoint<Endpoints>>(
    endpoint: K,
    ...init: NegotiatedStreamArgs<Endpoints, K, D>
  ): ReadableStream<EndpointStreamItem<Endpoints, K>>
}

type SelectedStreamMedia<E, K extends StreamEndpoint<E>, M extends StreamMedia<E, K>, H> =
  LowercaseHeaders<H> extends { accept: infer A extends StreamMedia<E, K> } ? A : M

/** Create a typed `fetch` from a generated module's `contract`. */
export function createClient<Endpoints>(
  contract: Contract<Endpoints>,
  options?: Omit<ClientOptions, "headers"> & { headers?: undefined },
): Client<Endpoints>
export function createClient<
  Endpoints,
  const H extends RequestInit["headers"] = RequestInit["headers"],
>(
  contract: Contract<Endpoints>,
  options: Omit<ClientOptions, "headers"> & { headers?: H | undefined },
): Client<Endpoints, DefaultMedia<H>>
export function createClient<Endpoints, const H extends RequestInit["headers"] = undefined>(
  contract: Contract<Endpoints>,
  options: Omit<ClientOptions, "headers"> & { headers?: H | undefined } = {},
): Client<Endpoints, DefaultMedia<H>> {
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
    const request = buildRequest(endpoint, call, defaults)
    const response = await send(request, { endpoint, kind: "result" })
    return readResult(response, request, defaults.endpoints[endpoint])
  }

  const stream = (endpoint: string, call: CallInit & StreamOptions = {}): ReadableStream<unknown> =>
    subscribe(endpoint, call, defaults, send)

  return { fetch, result, stream } as unknown as Client<Endpoints, DefaultMedia<H>>
}
