import type { EndpointContract } from "../shared/contract"
import { encodeBody } from "./body"
import { delimited, encodeContent, expandPath, normalize, serializeQuery } from "./serialization"
import type { BodyLike } from "./types"
import { isInstance, isStream } from "./values"

/** What a call takes at run time: its parameters, its body, and any other `RequestInit` field. */
export interface CallInit extends Omit<RequestInit, "headers" | "body"> {
  params?: Record<string, unknown>
  query?: unknown
  headers?: Headers | Array<[string, string]> | Record<string, unknown>
  body?: unknown
  contentType?: string
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
  const { params, query, headers: given, body: value, contentType, ...rest } = init

  let url = defaults.prefix + expandPath(path, params, declared.params)
  if (query !== undefined) url = appendQuery(url, serializeQuery(query, declared))

  const headers = new Headers(defaults.headers)
  let body: BodyLike | string | undefined
  if (value !== undefined) {
    const encoded = encodeBody(value, contentType ?? declared.contentType, declared)
    body = encoded.body
    // Without a label, the body's own type (a Blob's, FormData's boundary) applies.
    if (encoded.contentType === undefined) headers.delete("content-type")
    else headers.set("content-type", encoded.contentType)
  }
  // The call's own headers go over the client's and the body's. Iterable ones,
  // a `Headers` of any implementation or its entries, are taken as they are, as
  // `new Headers()` tells them from a record, repeated names too; a record's
  // values are serialized by their declared style.
  if (typeof given === "object" && given !== null && Symbol.iterator in given) {
    const own = new Headers(given)
    for (const name of own.keys()) headers.delete(name)
    for (const [name, header] of own) headers.append(name, header)
  } else {
    for (const [name, header] of Object.entries(given ?? {})) {
      if (header == null) continue
      const encoding = normalize(byLowercase(declared.headers, name), "simple")
      headers.set(
        name,
        encoding.contentType
          ? encodeContent(header, encoding.contentType)
          : delimited(header, encoding.explode, ",", (s) => s),
      )
    }
  }
  // Their content type is the body's own: a multipart boundary, a form encoding.
  if (isInstance(body, "FormData") || isInstance(body, "URLSearchParams")) {
    headers.delete("content-type")
  }
  const requestInit: RequestInit & { duplex?: "half" } = {
    ...defaults.init,
    ...rest,
    method,
    headers,
    body: (body as RequestInit["body"]) ?? null,
  }
  // Streaming request bodies need half duplex (Fetch Standard).
  if (isStream(body)) requestInit.duplex = "half"
  return new Request(url, requestInit)
}

function appendQuery(url: string, query: string): string {
  if (query === "") return url
  const hash = url.indexOf("#")
  const base = hash === -1 ? url : url.slice(0, hash)
  const fragment = hash === -1 ? "" : url.slice(hash)
  const separator = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&"
  return `${base}${separator}${query}${fragment}`
}

/** A header's entry, whatever the case of its name. */
function byLowercase<T>(map: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  const key = Object.keys(map ?? {}).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : map?.[key]
}
