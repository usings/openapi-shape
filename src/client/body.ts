import type { Encoding, EndpointContract } from "./contract"
import { encodeContent, formFields, formPairs, normalize } from "./parameters"
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
 * A request body: JSON, form, and multipart content is encoded from its value (multipart as
 * `FormData`), text is sent as given, and any other media type takes a ready body. A `Blob`,
 * `FormData`, `URLSearchParams`, buffer, or stream always passes through.
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
  const encodings = declared?.bodyEncodings
  const encoding = encodings && Object.hasOwn(encodings, type) ? encodings[type] : undefined
  if (essence === "application/x-www-form-urlencoded") {
    // A string is already encoded.
    if (typeof body === "string") return { body, contentType: label }
    if (!isPlainObject(body)) throw new TypeError("A form body must be an object")
    return { body: formFields(body, encoding ?? {}), contentType: label }
  }
  if (essence === "multipart/form-data") {
    if (!isPlainObject(body)) throw new TypeError("A multipart/form-data body must be an object")
    return { body: formData(body, encoding ?? {}), contentType: undefined }
  }
  if (typeof body === "string") return { body, contentType: label }
  throw new TypeError(`Cannot encode a ${typeof body} as ${type}; pass it encoded`)
}

/**
 * Blobs and buffers become files; other values text fields, objects as JSON; array properties
 * repeat. A field's declared `contentType` types its parts, and an explicit style serializes it as
 * a URL-encoded field would, without percent-encoding.
 */
function formData(
  body: Record<string, unknown>,
  encodings: Readonly<Record<string, Encoding>>,
): FormData {
  const form = new FormData()
  for (const [name, value] of Object.entries(body)) {
    const spec = Object.hasOwn(encodings, name) ? encodings[name] : undefined
    // Any of these makes the field style-based, and its contentType no longer applies.
    if (
      spec?.style !== undefined ||
      spec?.explode !== undefined ||
      spec?.allowReserved !== undefined
    ) {
      // A styled field is text, which would corrupt files and buffers.
      if (holdsBinary(value)) {
        throw new TypeError(
          `Multipart field "${name}" is declared with a style, which sends it as text; send its files in a ready FormData`,
        )
      }
      const encoding = { ...normalize(spec, "form"), contentType: undefined }
      for (const [key, text] of formPairs(name, value, encoding, true)) {
        form.append(key, text)
      }
      continue
    }
    const type = spec?.contentType
    const essence = type === undefined ? "" : mediaTypeEssence(type)
    // JSON null is a value; other parts omit nullish values.
    const json = isJsonEssence(essence) || isJsonWildcardEssence(essence)
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || (item === null && !json)) continue
      const raw = bytes(item)
      if (isInstance(item, "Blob")) {
        const blob = item as Blob
        // Retyping a File must retain its original filename.
        const filename = isInstance(blob, "File") ? (blob as File).name : undefined
        if (type === undefined) form.append(name, blob)
        else form.append(name, blob.slice(0, blob.size, type), filename)
      } else if (raw !== undefined) {
        form.append(name, new Blob([raw], { type: type ?? "" }))
      } else if (type === undefined || essence === "text/plain") {
        form.append(name, scalar(item))
      } else {
        // Only a Blob carries a part's type, which makes the part a file (named "blob").
        form.append(name, new Blob([encodeContent(item, type)], { type }))
      }
    }
  }
  return form
}

/** Whether a value holds a Blob or bytes, at any depth of its arrays and plain objects. */
function holdsBinary(value: unknown): boolean {
  if (isInstance(value, "Blob") || bytes(value) !== undefined) return true
  if (Array.isArray(value)) return value.some((item) => holdsBinary(item))
  return isPlainObject(value) && Object.values(value).some((item) => holdsBinary(item))
}

/**
 * A response body, by its content type: JSON parsed, `text/*` as a string, no content as
 * `undefined`, anything else as a `Blob`.
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
 * Raw bytes, `undefined` for any other value. Bytes in shared memory are copied out, since `fetch`
 * and `Blob` take only unshared ones.
 */
function bytes(value: unknown): ArrayBuffer | Uint8Array<ArrayBuffer> | undefined {
  if (value instanceof ArrayBuffer) return value
  const view =
    isInstance(value, "ArrayBuffer") || isInstance(value, "SharedArrayBuffer")
      ? new Uint8Array(value as ArrayBuffer | SharedArrayBuffer)
      : value
  if (!ArrayBuffer.isView(view)) return undefined
  const octets = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  return isInstance(octets.buffer, "ArrayBuffer")
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
