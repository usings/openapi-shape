/** A value as text: parameters, headers, and form fields. */
export function scalar(value: unknown): string {
  if (isInstance(value, "Date")) return (value as Date).toISOString()
  // Raw bytes are typed Blob wherever a schema declares them; as text they cannot go.
  if (isInstance(value, "Blob")) throw new TypeError("A Blob cannot be sent as text")
  return typeof value === "object" && value !== null ? toJson(value) : String(value)
}

/** JSON text. A Blob has no JSON form, so it is refused rather than sent as `{}`. */
export function toJson(value: unknown): string {
  const json = JSON.stringify(value, (_, item: unknown) => {
    if (isInstance(item, "Blob")) throw new TypeError("A Blob cannot be sent inside JSON")
    return item
  })
  if (json === undefined) throw new TypeError("The value is not JSON-serializable")
  return json
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto === null || proto === Object.prototype) return true
  // A foreign Object.prototype has its own native Object constructor and no parent.
  // Do not invoke a constructor getter or trust Symbol.toStringTag on an instance.
  if (Object.getPrototypeOf(proto) !== null) return false
  const ctor: unknown = Object.getOwnPropertyDescriptor(proto, "constructor")?.value
  return (
    typeof ctor === "function" &&
    Function.prototype.toString.call(ctor) === Function.prototype.toString.call(Object)
  )
}

/** Recognize native values across realms, checking their brand rather than their toStringTag. */
export function isInstance(
  value: unknown,
  name:
    | "Blob"
    | "File"
    | "FormData"
    | "URLSearchParams"
    | "ReadableStream"
    | "ArrayBuffer"
    | "SharedArrayBuffer"
    | "Date",
): boolean {
  if (typeof value !== "object" || value === null) return false
  const ctor = globalThis[name]
  if (typeof ctor !== "function") return false
  if (value instanceof ctor) return true
  try {
    // These operations check native state without changing or consuming the value.
    if (name === "Date") Date.prototype.getTime.call(value)
    else if (name === "FormData") FormData.prototype.has.call(value, "")
    else if (name === "URLSearchParams") URLSearchParams.prototype.has.call(value, "")
    else {
      const property =
        name === "Blob"
          ? "size"
          : name === "File"
            ? "name"
            : name === "ReadableStream"
              ? "locked"
              : "byteLength"
      const getter = Object.getOwnPropertyDescriptor(ctor.prototype, property)?.get
      if (getter === undefined) return false
      getter.call(value)
    }
    return true
  } catch {
    return false
  }
}

/** A web `ReadableStream`, or an async iterable such as a Node.js stream. */
export function isStream(value: unknown): boolean {
  return (
    isInstance(value, "ReadableStream") ||
    (typeof value === "object" && value !== null && Symbol.asyncIterator in value)
  )
}
