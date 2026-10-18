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

/** Lowercased `type/subtype` without parameters. */
function mediaTypeEssence(mediaType: string): string {
  // Only spaces and tabs surround it (RFC 9110, OWS), as the client's types trim them.
  return mediaType
    .split(";", 1)[0]
    .replaceAll(/^[ \t]+|[ \t]+$/g, "")
    .toLowerCase()
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

/**
 * The media type a request body is sent as when the call names none: the declared
 * `application/json` one, parameters and all, where one alone is; else the only one declared; else
 * none. The client's types apply the same rule (`DefaultMediaType` in src/client/types.ts).
 */
export function defaultMediaType(mediaTypes: string[]): string | undefined {
  const json = mediaTypes.filter((m) => isApplicationJson(m))
  if (json.length === 1) return json[0]
  return mediaTypes.length === 1 ? mediaTypes[0] : undefined
}

/** Whether a media type is `application/json`, whatever its parameters. */
export function isApplicationJson(mediaType: string): boolean {
  return mediaTypeEssence(mediaType) === "application/json"
}

/** Whether a media type takes JSON: `application/json`, or a wildcard that admits it. */
export function acceptsJson(mediaType: string): boolean {
  const essence = mediaTypeEssence(mediaType)
  return essence === "application/json" || essence === "*/*" || essence === "application/*"
}

const SEQUENCES = new Set(["application/jsonl", "application/x-ndjson", "application/json-seq"])
