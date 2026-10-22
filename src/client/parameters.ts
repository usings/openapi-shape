import type { Encoding, EndpointContract } from "./contract"
import {
  isJsonEssence,
  isJsonWildcardEssence,
  isPlainObject,
  mediaTypeEssence,
  scalar,
  toJson,
} from "./values"

interface Normalized {
  style: string
  explode: boolean
  allowReserved: boolean
  contentType: string | undefined
  repeat: boolean
}

type Pair = [name: string, value: string]

// `deepObject` is defined for explode: true only.
const EXPLODED = new Set(["form", "cookie", "deepObject"])

export function normalize(spec: Encoding | undefined, defaultStyle: string): Normalized {
  const style = spec?.style ?? defaultStyle
  return {
    style,
    explode: spec?.explode ?? EXPLODED.has(style),
    allowReserved: spec?.allowReserved ?? false,
    contentType: spec?.contentType,
    repeat: spec?.repeat === true,
  }
}

/** Path template expansion; `simple` style unless declared otherwise. */
export function expandPath(
  path: string,
  params: Record<string, unknown> | undefined,
  declared: EndpointContract["params"],
): string {
  if (!path.includes("{")) return path
  // A slash inside a placeholder belongs to its name, not to the URL hierarchy.
  return path.replaceAll(/(?:\{[^{}]+\}|[^/])+/g, (segment) => {
    const expanded = segment.replaceAll(/\{([^{}]+)\}/g, (_, name: string) =>
      expandParam(
        name,
        params != null && Object.hasOwn(params, name) ? params[name] : undefined,
        declared?.[name],
      ),
    )
    // A value that leaves a segment empty, ".", or ".." would send the request
    // to another resource once the URL is normalized.
    if (
      expanded !== segment &&
      expanded.split("/").some((part) => /^\.{0,2}$/.test(part.replaceAll(/%2e/gi, ".")))
    ) {
      throw new TypeError(`Path parameters turn "${segment}" into "${expanded}", another resource`)
    }
    return expanded
  })
}

/** A path template variable; `simple` style unless declared otherwise. */
function expandParam(name: string, value: unknown, spec: Encoding | undefined): string {
  if (value == null) throw new TypeError(`Missing path parameter "${name}"`)
  const { style, explode, allowReserved, contentType } = normalize(spec, "simple")
  const enc = (s: string): string => encode(s, allowReserved ? PATH_RESERVED : null)
  if (contentType) return enc(encodeContent(value, contentType))
  if (style === "label") return `.${delimited(value, explode, explode ? "." : ",", enc)}`
  if (style === "matrix") {
    const key = encode(name, null)
    if (Array.isArray(value) && explode) {
      return value.map((v) => `;${key}=${enc(scalar(v))}`).join("")
    }
    if (isPlainObject(value) && explode) {
      return Object.entries(value)
        .map(([k, v]) => `;${enc(k)}=${enc(scalar(v))}`)
        .join("")
    }
    return `;${key}=${delimited(value, false, ",", enc)}`
  }
  return delimited(value, explode, ",", enc)
}

/** Arrays and objects as delimited lists; exploded objects as `key=value` items. */
export function delimited(
  value: unknown,
  explode: boolean,
  separator: string,
  enc: (s: string) => string,
): string {
  if (Array.isArray(value)) return value.map((v) => enc(scalar(v))).join(separator)
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v != null)
    return explode
      ? entries.map(([k, v]) => `${enc(k)}=${enc(scalar(v))}`).join(separator)
      : entries.flatMap(([k, v]) => [enc(k), enc(scalar(v))]).join(",")
  }
  return enc(scalar(value))
}

export function serializeQuery(query: unknown, declared: EndpointContract | undefined): string {
  if (declared?.querystring !== undefined) {
    return encode(encodeContent(query, declared.querystring), null)
  }
  if (!isPlainObject(query)) return encode(scalar(query), null)
  return formFields(query, declared?.query ?? {})
}

/** Fields as `name=value&…`, without a content encoding, use the form style, exploded by default. */
export function formFields(
  fields: Record<string, unknown>,
  encodings: Readonly<Record<string, Encoding>>,
): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(fields)) {
    const encoding = normalize(Object.hasOwn(encodings, name) ? encodings[name] : undefined, "form")
    for (const [key, encoded] of formPairs(name, value, encoding)) {
      parts.push(`${encodeKey(key)}=${encoded}`)
    }
  }
  return parts.join("&")
}

/** Style-based field pairs, percent-encoded except in multipart bodies. */
export function formPairs(
  name: string,
  value: unknown,
  encoding: Normalized,
  multipart = false,
): Pair[] {
  if (value === undefined) return []
  const { style, explode, contentType } = encoding
  const enc = (s: string): string =>
    multipart ? s : encode(s, encoding.allowReserved ? QUERY_RESERVED : null)
  // JSON null is a value; style-based and other textual fields omit null.
  if (value === null) {
    const essence = contentType === undefined ? "" : mediaTypeEssence(contentType)
    if (!isJsonEssence(essence) && !isJsonWildcardEssence(essence)) return []
  }
  if (contentType) {
    const values = encoding.repeat && Array.isArray(value) ? value : [value]
    return values
      .filter((item) => item !== undefined)
      .flatMap((item) => {
        const essence = mediaTypeEssence(contentType)
        if (item === null && !isJsonEssence(essence) && !isJsonWildcardEssence(essence)) return []
        return [[name, enc(encodeContent(item, contentType))]]
      })
  }
  if (style === "deepObject") {
    const pairs: Pair[] = []
    brackets(name, value, pairs)
    return pairs.map(([k, v]) => [k, enc(v)])
  }
  // Commas stay as they are; a space or pipe is encoded like the values.
  const separator =
    style === "spaceDelimited" ? enc(" ") : style === "pipeDelimited" ? enc("|") : ","
  if (Array.isArray(value)) {
    const items = value.filter((v) => v != null).map((v) => enc(scalar(v)))
    if (explode) return items.map((item) => [name, item])
    return [[name, items.join(separator)]]
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v != null)
    // An exploded object contributes its properties as parameters.
    if (explode) return entries.map(([k, v]) => [k, enc(scalar(v))])
    return [[name, entries.flatMap(([k, v]) => [enc(k), enc(scalar(v))]).join(separator)]]
  }
  return [[name, enc(scalar(value))]]
}

/** `deepObject`: `name[key]=value`, nested objects and arrays indexed the same way. */
function brackets(name: string, value: unknown, pairs: Pair[]): void {
  if (value == null) return
  if (Array.isArray(value)) {
    const length = value.length
    for (let i = 0; i < length; i++) {
      if (i in value) brackets(`${name}[${i}]`, value[i], pairs)
    }
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) brackets(`${name}[${k}]`, v, pairs)
  } else {
    pairs.push([name, scalar(value)])
  }
}

/** A value serialized as a media type (parameters with `content`). */
export function encodeContent(value: unknown, contentType: string): string {
  const essence = mediaTypeEssence(contentType)
  return isJsonEssence(essence) || isJsonWildcardEssence(essence) ? toJson(value) : scalar(value)
}

/**
 * Reserved characters that `allowReserved` leaves as they are (RFC 3986): in a path, all but those
 * ending it (`?`, `#`) or not allowed there (`[`, `]`); in a query or form field, also not `&`,
 * `=`, and `+`, which delimit or mean a space there (OpenAPI 3.1.1, "Parameter Object").
 */
const PATH_RESERVED = /%(?:3A|2F|40|21|24|26|27|28|29|2A|2B|2C|3B|3D)/gi

const QUERY_RESERVED = /%(?:3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi

/** Percent-encode; with `reserved`, those characters and existing percent-encodings are kept. */
function encode(value: string, reserved: RegExp | null): string {
  const encoded = encodeURIComponent(value)
  if (reserved === null) return encoded
  return encoded
    .replaceAll(reserved, (m) => decodeURIComponent(m))
    .replaceAll(/%25([0-9A-Fa-f]{2})/g, "%$1")
}

/** Bracket notation stays readable: `created[gte]`. */
function encodeKey(key: string): string {
  return encodeURIComponent(key).replaceAll("%5B", "[").replaceAll("%5D", "]")
}

export function appendQuery(url: string, query: string): string {
  if (query === "") return url
  const hash = url.indexOf("#")
  const base = hash === -1 ? url : url.slice(0, hash)
  const fragment = hash === -1 ? "" : url.slice(hash)
  const separator = !base.includes("?") ? "?" : base.endsWith("?") || base.endsWith("&") ? "" : "&"
  return `${base}${separator}${query}${fragment}`
}

/** A header's entry, whatever the case of its name. */
export function byLowercase<T>(
  map: Readonly<Record<string, T>> | undefined,
  name: string,
): T | undefined {
  const key = Object.keys(map ?? {}).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : map?.[key]
}
