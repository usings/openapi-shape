import { identity } from "./document-nodes"
import type { DocumentNode, DocumentSet } from "./documents"
import { classifyMediaType, isTextRange } from "./media-types"
import { isRecord } from "./object"
import { aliasReference, describesRawBytes } from "./schema-rules"

type ContentSource =
  | { kind: "schema" | "items"; node: DocumentNode }
  | { kind: "unknown" | "string" | "blob" | "array" }
  /** Discovery retries unresolved text aliases; compilation keeps their fallback representation. */
  | { kind: "unresolved"; fallback: "unknown" | "string" }

/** The schema that determines a media value, or its representation without a schema. */
export function selectContentSource(
  documents: DocumentSet,
  node: DocumentNode,
  mediaType: string,
  parameter = false,
): { source: ContentSource; ignoredItemSchema: boolean } {
  const media = isRecord(node.value) ? node.value : {}
  const kind = classifyMediaType(mediaType)
  const schema = (): ContentSource =>
    "schema" in media
      ? { kind: "schema", node: documents.child(node, "schema") }
      : { kind: "unknown" }
  if (parameter)
    return { source: kind === "json" ? schema() : { kind: "string" }, ignoredItemSchema: false }

  const itemSchema = "itemSchema" in media
  if (itemSchema && (kind === "events" || kind === "sequence")) {
    return {
      source: { kind: "items", node: documents.child(node, "itemSchema") },
      ignoredItemSchema: false,
    }
  }
  let source: ContentSource
  switch (kind) {
    case "json":
    case "form":
    case "multipart":
      source = schema()
      break
    case "sequence":
      source = "schema" in media ? schema() : { kind: "array" }
      break
    case "events":
    case "text": {
      const fallback = isTextRange(mediaType) ? "unknown" : "string"
      const selected = "schema" in media ? schema() : undefined
      const strings = selected?.kind === "schema" && describesStrings(documents, selected.node)
      source =
        strings === "unresolved"
          ? { kind: "unresolved", fallback }
          : strings && selected
            ? selected
            : { kind: fallback }
      break
    }
    case "binary":
      source = { kind: "blob" }
      break
  }
  return { source, ignoredItemSchema: itemSchema }
}

/** Schema wins over content; otherwise the first content entry determines a parameter or header. */
export function selectParameterValue(documents: DocumentSet, node: DocumentNode) {
  const value = isRecord(node.value) ? node.value : {}
  if ("schema" in value) return { kind: "schema" as const, node: documents.child(node, "schema") }
  const [mediaType] = isRecord(value.content) ? Object.keys(value.content) : []
  return mediaType === undefined
    ? { kind: "none" as const }
    : { kind: "content" as const, node: documents.child(node, "content", mediaType), mediaType }
}

function describesStrings(documents: DocumentSet, node: DocumentNode): boolean | "unresolved" {
  let current = node
  const seen = new Set<string>()
  for (let alias = aliasReference(current); alias; alias = aliasReference(current)) {
    const result = documents.resolveSchema(alias[1], current)
    if (result.kind !== "found") return "unresolved"
    if (seen.has(identity(result.node))) break
    seen.add(identity(result.node))
    current = result.node
  }
  const value = current.value
  if (!isRecord(value) || describesRawBytes(current)) return false
  if (value.type !== undefined) return value.type === "string"
  const values = Array.isArray(value.enum) ? value.enum : "const" in value ? [value.const] : []
  return values.length > 0 && values.every((item) => typeof item === "string")
}
