import type { EndpointContract } from "../shared/contract"
import { mergeHeaders } from "./headers"
import { matchDeclaredMedia } from "./media"
import { encodeBody, isReadyBody } from "./request-body"
import { expandPath, parameterEncodings, serializeQuery } from "./serialization"
import { isStream } from "./values"

/** What a call takes at run time: its parameters, its body, and any other `RequestInit` field. */
export interface CallInit extends Omit<RequestInit, "headers" | "body"> {
  baseURL?: string | URL | undefined
  params?: Record<string, unknown>
  query?: unknown
  headers?: Headers | Array<[string, string]> | Record<string, unknown>
  body?: unknown
}

/** What every request of a client shares. */
export interface RequestDefaults {
  endpoints: Readonly<Record<string, EndpointContract | undefined>>
  /** The base URL, without a trailing slash; endpoint paths go after it. */
  prefix: string
  headers: RequestInit["headers"]
  /** The client's other `RequestInit` fields. */
  init: Omit<RequestInit, "method" | "body" | "headers" | "signal">
}

/** The standard `Request` for a call: its URL, headers, and body, as the contract declares them. */
export function buildRequest(endpoint: string, init: CallInit, defaults: RequestDefaults): Request {
  const declared = Object.hasOwn(defaults.endpoints, endpoint)
    ? defaults.endpoints[endpoint]
    : undefined
  if (!declared) throw new TypeError(`Unknown endpoint "${endpoint}"; use a generated contract`)
  const separator = endpoint.indexOf(" ")
  const method = endpoint.slice(0, separator)
  const path = endpoint.slice(separator + 1)
  const { baseURL, params, query, headers: given, body: value, ...rest } = init

  const prefix = baseURL === undefined ? defaults.prefix : normalizeBaseURL(baseURL)
  let url = prefix + expandPath(path, params, parameterEncodings(declared.parameters?.path))
  if (query === undefined && declared.querystring?.required)
    throw new TypeError("This operation requires query input")
  for (const [name, field] of Object.entries(declared.parameters?.query ?? {})) {
    if (
      field.required &&
      (query === null ||
        typeof query !== "object" ||
        !Object.hasOwn(query, name) ||
        (query as Record<string, unknown>)[name] === undefined)
    )
      throw new TypeError(`Missing query parameter "${name}"`)
  }
  if (query !== undefined) url = appendQuery(url, serializeQuery(query, declared))

  const headers = mergeHeaders(defaults.headers, given, declared.parameters?.header)
  if (
    value === undefined &&
    declared.requestBody?.required &&
    !["GET", "HEAD"].includes(method.toUpperCase())
  )
    throw new TypeError("This endpoint requires a request body")
  const ready = value !== undefined && isReadyBody(value)
  const selected =
    headers.get("content-type") ?? (value !== undefined && !ready ? "application/json" : undefined)
  if (selected && !headers.has("content-type")) headers.set("content-type", selected)
  if (value !== undefined && selected?.split(";")[0]?.includes("*"))
    throw new TypeError("Content-Type must identify a concrete request media type")
  const content = declared.requestBody?.content
  const representation =
    content && selected ? content[matchDeclaredMedia(content, selected) ?? ""] : undefined
  if (value !== undefined && !ready && selected && declared.requestBody && !representation)
    throw new TypeError(`Undeclared request Content-Type "${selected}"`)
  const encoded =
    value === undefined ? undefined : encodeBody(value, selected, representation?.encoding)
  const body = encoded?.body
  if (encoded?.contentType.kind === "default" && encoded.contentType.value !== undefined)
    headers.set("content-type", encoded.contentType.value)
  // The encoder may require Request to supply a multipart boundary or form encoding.
  if (encoded?.contentType.kind === "native") headers.delete("content-type")
  const requestInit: RequestInit & { duplex?: "half" } = {
    ...defaults.init,
    ...rest,
    method,
    headers,
    body: (body as RequestInit["body"]) ?? null,
  }
  // Streaming request bodies need half duplex (Fetch Standard).
  if (isStream(body)) requestInit.duplex = "half"
  const request = new Request(url, requestInit)
  const actual = request.headers.get("content-type")
  if (
    value !== undefined &&
    declared.requestBody &&
    actual &&
    !matchDeclaredMedia(declared.requestBody.content, actual)
  ) {
    void request.body?.cancel().catch(() => {
      /* Construction failed; retain the contract error. */
    })
    throw new TypeError(`Undeclared request Content-Type "${actual}"`)
  }
  return request
}

/** Endpoint paths append to this prefix, so a query or fragment cannot be part of it. */
export function normalizeBaseURL(baseURL: string | URL | undefined): string {
  const prefix = baseURL === undefined ? "" : String(baseURL).replace(/\/+$/, "")
  if (/[?#]/.test(prefix)) throw new TypeError(`baseURL "${prefix}" has a query or fragment`)
  return prefix
}

function appendQuery(url: string, query: string): string {
  if (query === "") return url
  const hash = url.indexOf("#")
  const base = hash === -1 ? url : url.slice(0, hash)
  const fragment = hash === -1 ? "" : url.slice(hash)
  const separator = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&"
  return `${base}${separator}${query}${fragment}`
}
