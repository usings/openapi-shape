import type { EndpointContract } from "./contract"
import { formFields } from "./parameters"
import type { BodyLike } from "./types"
import {
  isInstance,
  isJsonEssence,
  isJsonWildcardEssence,
  isPlainObject,
  mediaTypeEssence,
  scalar,
  toJson,
} from "./values"

// Request bodies encoded by their media type, and response bodies decoded by theirs.

/**
 * A request body: JSON, form, and multipart content is encoded from its value
 * (multipart as `FormData`), text is sent as given, and any other media type
 * takes a ready body. A `Blob`, `FormData`, `URLSearchParams`, buffer, or
 * stream always passes through.
 */
export function encodeBody(
  body: unknown,
  contentType: string | undefined,
  declared: EndpointContract | undefined,
): { body: BodyLike | string; contentType: string | undefined } {
  const type = contentType ?? "application/json"
  const essence = contentType === undefined ? "application/json" : mediaTypeEssence(contentType)
  // A wildcard media type cannot label a request; a `*` in a parameter can.
  const label = contentType !== undefined && essence.includes("*") ? undefined : contentType
  const ready = readyBody(body)
  if (ready !== undefined) {
    // fetch derives multipart boundaries and form encodings itself.
    const own = isInstance(ready, "FormData") || isInstance(ready, "URLSearchParams")
    return { body: ready, contentType: own ? undefined : label }
  }
  if (isJsonEssence(essence) || isJsonWildcardEssence(essence)) {
    // Labelled as the call names it, else as the operation declares its JSON.
    const declaredJson = contentType === undefined ? declared?.json : undefined
    return { body: toJson(body), contentType: label ?? declaredJson ?? "application/json" }
  }
  if (essence === "application/x-www-form-urlencoded") {
    // A string is already encoded.
    if (typeof body === "string") return { body, contentType: label }
    if (!isPlainObject(body)) throw new TypeError("A form body must be an object")
    return { body: formFields(body, declared?.encoding ?? {}), contentType: label }
  }
  if (essence === "multipart/form-data") {
    if (!isPlainObject(body)) throw new TypeError("A multipart/form-data body must be an object")
    return { body: formData(body), contentType: undefined }
  }
  if (typeof body === "string") return { body, contentType: label }
  throw new TypeError(`Cannot encode a ${typeof body} as ${type}; pass it encoded`)
}

/** Blobs and buffers become files; other values text fields, objects as JSON; array properties repeat. */
function formData(body: Record<string, unknown>): FormData {
  const form = new FormData()
  for (const [name, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item == null) continue
      const raw = bytes(item)
      if (isInstance(item, "Blob")) form.append(name, item as Blob)
      else if (raw !== undefined) form.append(name, new Blob([raw]))
      else form.append(name, scalar(item))
    }
  }
  return form
}

/**
 * A response body, by its content type: JSON parsed, `text/*` as a string, no
 * content as `undefined`, anything else as a `Blob`.
 */
export async function decodeBody(response: Response, method: string): Promise<unknown> {
  if (method === "HEAD" || [204, 205, 304].includes(response.status)) {
    await response.body?.cancel()
    return undefined
  }
  const type = response.headers.get("content-type")
  if (type === null) {
    // An empty body without a content type is no content.
    const blob = await response.blob()
    return blob.size === 0 ? undefined : blob
  }
  const essence = mediaTypeEssence(type)
  if (isJsonEssence(essence)) {
    const text = await response.text()
    // JSON's own whitespace: space, tab, and line breaks.
    if (/^[ \t\n\r]*$/.test(text)) return undefined
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new SyntaxError(`The ${response.status} response is not the JSON it says`, {
        cause: error,
      })
    }
  }
  if (essence.startsWith("text/")) return response.text()
  return response.blob()
}

// --- helpers --------------------------------------------------------------------

/** A body `fetch` sends as it is, `undefined` for a value to encode. */
function readyBody(value: unknown): BodyLike | undefined {
  const ready =
    isInstance(value, "Blob") ||
    isInstance(value, "FormData") ||
    isInstance(value, "URLSearchParams") ||
    isStream(value)
  return ready ? (value as BodyLike) : bytes(value)
}

/**
 * Raw bytes, `undefined` for any other value. Bytes in shared memory are
 * copied out, since `fetch` and `Blob` take only unshared ones.
 */
function bytes(value: unknown): ArrayBuffer | Uint8Array<ArrayBuffer> | undefined {
  if (value instanceof ArrayBuffer) return value
  const view = isInstance(value, "SharedArrayBuffer")
    ? new Uint8Array(value as SharedArrayBuffer)
    : value
  if (!ArrayBuffer.isView(view)) return undefined
  const octets = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  return octets.buffer instanceof ArrayBuffer
    ? (octets as Uint8Array<ArrayBuffer>)
    : new Uint8Array(octets)
}

/** A web `ReadableStream`, or an async iterable such as a Node.js stream. */
export function isStream(value: unknown): boolean {
  return (
    isInstance(value, "ReadableStream") ||
    (typeof value === "object" && value !== null && Symbol.asyncIterator in value)
  )
}

// --- types ----------------------------------------------------------------------
