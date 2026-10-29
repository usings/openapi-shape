import { mediaTypeEssence } from "../shared/media"

/**
 * What content of a media type carries, which decides its type:
 *
 * - `json`: parsed JSON: `…/json`, `…/…+json`, and the wildcards that take JSON, `*` + `/*` and
 *   `application/*`.
 * - `events`: `text/event-stream`, a list of server-sent events.
 * - `sequence`: a list of JSON values (`application/jsonl`, `application/x-ndjson`,
 *   `application/json-seq`, `…+json-seq`).
 * - `text`: any other `text/*`: a string.
 * - `form`: `application/x-www-form-urlencoded` fields.
 * - `multipart`: `multipart/*` parts.
 * - `binary`: anything else: raw bytes.
 */
type MediaClass = "json" | "events" | "sequence" | "text" | "form" | "multipart" | "binary"

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

/** Whether a media type is `multipart/form-data`, whose parts are named form fields. */
export function isFormData(mediaType: string): boolean {
  return mediaTypeEssence(mediaType) === "multipart/form-data"
}

/** Whether a media type is the range `text/*`, which takes JSON (`text/json`) as well as text. */
export function isTextRange(mediaType: string): boolean {
  return mediaTypeEssence(mediaType) === "text/*"
}

/** Whether a media type takes JSON: `application/json`, or a wildcard that admits it. */
export function acceptsJson(mediaType: string): boolean {
  const essence = mediaTypeEssence(mediaType)
  return essence === "application/json" || essence === "*/*" || essence === "application/*"
}

const SEQUENCES = new Set(["application/jsonl", "application/x-ndjson", "application/json-seq"])
