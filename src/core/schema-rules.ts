import type { DocumentNode } from "./documents"
import { classifyMediaType } from "./media-types"
import { isRecord } from "./object"
import { referencesOf } from "./object-references"

/** Structural schema keywords shared by discovery and compilation. */
export const OBJECT_KEYWORDS = [
  "properties",
  "patternProperties",
  "additionalProperties",
  "required",
] as const
export const ARRAY_KEYWORDS = ["items", "prefixItems"] as const
export const COMPOSITION_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const

/** Keywords that change a schema's type. */
const TYPE_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "format",
  "nullable",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "items",
  "prefixItems",
  "additionalItems",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "discriminator",
  "readOnly",
  "writeOnly",
  "$ref",
  "$dynamicRef",
])

/**
 * Whether a schema describes raw bytes: a `format: binary` string, a string of a binary
 * `contentMediaType` without `contentEncoding`, or Swagger's `type: file`.
 */
export function describesRawBytes(node: DocumentNode): boolean {
  const schema = node.value
  if (!isRecord(schema)) return false
  if (schema.type === "file") return true
  const strings =
    schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"))
  if (!strings) return false
  if (schema.format === "binary") return true
  return (
    typeof schema.contentMediaType === "string" &&
    schema.contentEncoding === undefined &&
    classifyMediaType(schema.contentMediaType) === "binary"
  )
}

/** A reference whose siblings only annotate its target, rather than constrain its type. */
export function aliasReference(node: DocumentNode): ["$ref" | "$dynamicRef", string] | undefined {
  const schema = node.value
  const references = referencesOf(schema)
  if (!isRecord(schema) || references.length !== 1) return undefined
  const [[keyword, ref]] = references
  if (Object.keys(schema).some((key) => key !== keyword && TYPE_KEYWORDS.has(key))) return undefined
  return [keyword, ref]
}

/** Explicit dialects supported by the schema projection. */
export function supportedDialect(value: string): boolean {
  return [
    "https://json-schema.org/draft/2020-12/schema",
    "https://spec.openapis.org/oas/3.1/dialect/base",
    "https://spec.openapis.org/oas/3.2/dialect/base",
  ].includes(value.replace(/#$/, ""))
}
