import type { ParameterContract } from "../shared/contract"
import type { CallInit } from "./request"
import { delimited, encodeContent, normalize, parameterEncodings } from "./serialization"

export function mergeHeaders(
  defaults: RequestInit["headers"],
  given: CallInit["headers"],
  parameters?: Readonly<Record<string, ParameterContract>>,
): Headers {
  const encodings = parameterEncodings(parameters)
  const headers = new Headers(defaults)
  // The call's own headers override the client's. Iterable ones,
  // a `Headers` of any implementation or its entries, are taken as they are, as
  // `new Headers()` tells them from a record, repeated names too; a record's
  // values are serialized by their declared style.
  if (typeof given === "object" && given !== null && Symbol.iterator in given) {
    const own = new Headers(given)
    for (const name of own.keys()) headers.delete(name)
    for (const [name, header] of own) headers.append(name, header)
  } else {
    const mediaHeaders = new Map<string, unknown>()
    for (const [name, headerValue] of Object.entries(given ?? {})) {
      const key = name.toLowerCase()
      if ((key === "content-type" || key === "accept") && headerValue != null) {
        if (mediaHeaders.has(key) && mediaHeaders.get(key) !== headerValue)
          throw new TypeError(`Conflicting ${key} header values`)
        mediaHeaders.set(key, headerValue)
      }
    }
    for (const [name, header] of Object.entries(given ?? {})) {
      if (header == null) continue
      const encoding = normalize(byLowercase(encodings, name), "simple")
      headers.set(
        name,
        encoding.contentType
          ? encodeContent(header, encoding.contentType)
          : delimited(header, encoding.explode, ",", (s) => s),
      )
    }
  }
  return headers
}

/** A header's entry, whatever the case of its name. */
function byLowercase<T>(map: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  const key = Object.keys(map ?? {}).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : map?.[key]
}
