/** Lowercased `type/subtype` without parameters. */
export function mediaTypeEssence(mediaType: string): string {
  // Only spaces and tabs surround it (RFC 9110, OWS), as the client's types trim them.
  return mediaType
    .split(";", 1)[0]
    .replaceAll(/^[ \t]+|[ \t]+$/g, "")
    .toLowerCase()
}

/** `…/json` and `…/…+json`, from an already normalized essence. */
export function isJsonEssence(essence: string): boolean {
  const subtype = essence.split("/", 2)[1] ?? ""
  return subtype === "json" || subtype.endsWith("+json")
}

/** The wildcards that take JSON, as the client's default. */
export function isJsonWildcardEssence(essence: string): boolean {
  return essence === "*/*" || essence === "application/*"
}

/** A value as text: parameters, headers, and form fields. */
export function scalar(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
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
  return proto === Object.prototype || proto === null
}

export function isInstance(
  value: unknown,
  name: "Blob" | "File" | "FormData" | "URLSearchParams" | "ReadableStream" | "SharedArrayBuffer",
): boolean {
  const ctor = (globalThis as Record<string, unknown>)[name]
  return typeof ctor === "function" && value instanceof ctor
}
