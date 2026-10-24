/** Lowercased `type/subtype` without parameters. */
export function mediaTypeEssence(mediaType: string): string {
  // Only spaces and tabs surround it (RFC 9110, OWS), as the client's types trim them.
  const parameters = mediaType.indexOf(";")
  return (parameters === -1 ? mediaType : mediaType.slice(0, parameters))
    .replaceAll(/^[ \t]+|[ \t]+$/g, "")
    .toLowerCase()
}

/** The streaming formats this client decodes; JSON text sequences use different framing. */
export function streamFormat(mediaType: string): "sse" | "ndjson" | undefined {
  switch (mediaTypeEssence(mediaType)) {
    case "text/event-stream":
      return "sse"
    case "application/jsonl":
    case "application/x-ndjson":
      return "ndjson"
    default:
      return undefined
  }
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
