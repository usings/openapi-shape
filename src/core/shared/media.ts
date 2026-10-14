/**
 * How content of a media type goes over the wire, as openapi-shape/client
 * encodes and decodes it; the generator types content by the same classes, so
 * that types and the wire agree.
 *
 * - `json`: parsed JSON: `…/json`, `…/…+json`, and the wildcards that take
 *   JSON, `*` + `/*` and `application/*`.
 * - `events`: `text/event-stream`, a list of server-sent events.
 * - `sequence`: a list of JSON values (`application/jsonl`, `application/x-ndjson`,
 *   `application/json-seq`, `…+json-seq`).
 * - `text`: any other `text/*`: a string.
 * - `form`: `application/x-www-form-urlencoded` fields.
 * - `multipart`: `multipart/*` parts.
 * - `binary`: anything else: raw bytes.
 */
export type MediaClass = "json" | "events" | "sequence" | "text" | "form" | "multipart" | "binary"

/** Lowercased `type/subtype` without parameters. */
function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(";", 1)[0].trim().toLowerCase()
}

export function classifyMediaType(mediaType: string): MediaClass {
  const essence = mediaTypeEssence(mediaType)
  const [type = "", subtype = ""] = essence.split("/", 2)
  if (acceptsJson(essence) || subtype === "json" || subtype.endsWith("+json")) return "json"
  if (essence === "text/event-stream") return "events"
  if (SEQUENCES.has(essence) || subtype.endsWith("+json-seq")) return "sequence"
  if (type === "text") return "text"
  if (essence === "application/x-www-form-urlencoded") return "form"
  if (type === "multipart") return "multipart"
  return "binary"
}

/** Whether a declared request media type takes JSON, the client's default. */
export function acceptsJson(mediaType: string): boolean {
  const essence = mediaTypeEssence(mediaType)
  return essence === "application/json" || essence === "*/*" || essence === "application/*"
}

const SEQUENCES = new Set(["application/jsonl", "application/x-ndjson", "application/json-seq"])
