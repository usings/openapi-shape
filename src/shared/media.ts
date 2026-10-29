/** Lowercased `type/subtype` without parameters. */
export function mediaTypeEssence(mediaType: string): string {
  // Only spaces and tabs surround it (RFC 9110, OWS), as the client's types trim them.
  const parameters = mediaType.indexOf(";")
  return (parameters === -1 ? mediaType : mediaType.slice(0, parameters))
    .replaceAll(/^[ \t]+|[ \t]+$/g, "")
    .toLowerCase()
}

const streamFormats = {
  "text/event-stream": "sse",
  "application/jsonl": "jsonl",
  "application/x-ndjson": "jsonl",
  "application/json-seq": "json-seq",
} as const

/** Media essences supported by both stream selection types and runtime decoding. */
export type StreamingEssence = keyof typeof streamFormats
type StreamFormat = (typeof streamFormats)[StreamingEssence]

/** The streaming formats this client decodes. */
export function streamFormat(mediaType: string): StreamFormat | undefined {
  const essence = mediaTypeEssence(mediaType)
  return Object.hasOwn(streamFormats, essence)
    ? streamFormats[essence as StreamingEssence]
    : undefined
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

export function mediaParameters(value: string): Map<string, string> {
  const result = new Map<string, string>()
  const pattern = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g
  for (const match of value.matchAll(pattern)) {
    const raw = (match[2] ?? "").trim()
    const decoded = raw.startsWith('"') ? raw.slice(1, -1).replaceAll(/\\(.)/g, "$1") : raw
    const name = (match[1] ?? "").toLowerCase()
    if (result.has(name)) continue
    result.set(name, (match[1] ?? "").toLowerCase() === "charset" ? decoded.toLowerCase() : decoded)
  }
  return result
}
