import type { Encoding } from "../shared/contract"
import { isJsonEssence, isJsonWildcardEssence, mediaTypeEssence } from "../shared/media"
import { encodeContent, formFields, formPairs, normalize } from "./serialization"
import type { BodyLike } from "./types/request"
import { isInstance, isPlainObject, isStream, scalar, toJson } from "./values"

// Encode request values while preserving native body ownership.

/** Native types override explicit headers; defaults can be overridden by the call. */
type ContentTypePolicy = { kind: "native" } | { kind: "default"; value: string | undefined }

/**
 * A request body: JSON, form, and multipart content is encoded from its value (multipart as
 * `FormData`), text is sent as given, and any other media type takes a ready body. A `Blob`,
 * `FormData`, `URLSearchParams`, buffer, or stream always passes through.
 */
export function encodeBody(
  body: unknown,
  contentType: string | undefined,
  encoding?: Readonly<Record<string, Encoding>>,
): {
  body: BodyLike | string
  contentType: ContentTypePolicy
} {
  const type = contentType ?? ""
  const essence = mediaTypeEssence(type)
  const label = contentType
  const ready = readyBody(body)
  if (ready !== undefined) {
    // fetch derives multipart boundaries and form encodings itself.
    const own = isInstance(ready, "FormData") || isInstance(ready, "URLSearchParams")
    return {
      body: ready,
      contentType: own ? { kind: "native" } : { kind: "default", value: label },
    }
  }
  if (!contentType) throw new TypeError("Structured bodies require a Content-Type header")
  if (isJsonEssence(essence)) {
    return {
      body: toJson(body),
      contentType: { kind: "default", value: label },
    }
  }
  if (essence === "application/x-www-form-urlencoded") {
    // A string is already encoded.
    if (typeof body === "string") return { body, contentType: { kind: "default", value: label } }
    if (!isPlainObject(body)) throw new TypeError("A form body must be an object")
    return {
      body: formFields(body, encoding ?? {}, true),
      contentType: { kind: "default", value: label },
    }
  }
  if (essence === "multipart/form-data") {
    if (!isPlainObject(body)) throw new TypeError("A multipart/form-data body must be an object")
    return {
      body: formData(body, encoding ?? {}),
      contentType: { kind: "native" },
    }
  }
  if (typeof body === "string") return { body, contentType: { kind: "default", value: label } }
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

/** A body `fetch` sends as it is, `undefined` for a value to encode. */
/** Detect ready request bodies without acquiring an async iterator. */
export function isReadyBody(value: unknown): boolean {
  return (
    bytes(value) !== undefined ||
    isStream(value) ||
    (["Blob", "FormData", "URLSearchParams", "ReadableStream"] as const).some((name) =>
      isInstance(value, name),
    )
  )
}

export function readyBody(value: unknown): BodyLike | undefined {
  const ready =
    isInstance(value, "Blob") ||
    isInstance(value, "FormData") ||
    isInstance(value, "URLSearchParams") ||
    isInstance(value, "ReadableStream")
  if (ready) return value as BodyLike
  return (
    bytes(value) ?? (isStream(value) ? iterableBody(value as AsyncIterable<Uint8Array>) : undefined)
  )
}

/** Browsers need a Web stream; passing an async iterable directly would send its string tag. */
function iterableBody(value: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = value[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const result = await iterator.next()
        if (result.done) controller.close()
        else controller.enqueue(result.value)
      },
      async cancel(reason) {
        await iterator.return?.(reason)
      },
    },
    { highWaterMark: 0 },
  )
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
