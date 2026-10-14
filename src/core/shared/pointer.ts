/** Append RFC 6901 reference tokens to a JSON Pointer. */
export function appendPointer(base: string, ...segments: Array<string | number>): string {
  let out = base
  for (const segment of segments) {
    out += `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`
  }
  return out
}

/** Split a JSON Pointer into decoded reference tokens; `null` when malformed. */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === "") return []
  if (!pointer.startsWith("/")) return null
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
}

/** Read the value at a JSON Pointer; `undefined` when any token is missing. */
export function readPointer(root: unknown, tokens: string[]): unknown {
  let current = root
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined
      current = current[Number(token)]
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token]
    } else {
      return undefined
    }
  }
  return current
}
