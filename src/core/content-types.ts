import type { DocumentNode } from "./documents"
import { classifyMediaType, isTextRange } from "./media-types"
import type { Type } from "./model"
import { UNKNOWN } from "./model"
import { isRecord } from "./object"
import { describesRawBytes } from "./schema-rules"
import type { SchemaBuilder } from "./schemas"

const BLOB: Type = { kind: "blob" }
const STRING: Type = { kind: "string" }

/**
 * The type of one Media Type Object's content, by the class of its media type
 * (`classifyMediaType`): JSON, form, multipart, and JSON sequence content is typed by its schema;
 * `itemSchema` on a sequence describes an array of items; other text is a string, or the schema's
 * type when it says which strings (`unknown` under `text/*`, which may be JSON); anything else is
 * raw bytes, a `Blob`. A parameter's content is typed by its schema when it is JSON, and as a
 * string otherwise.
 */
export function typeOfContent(
  schemas: SchemaBuilder,
  node: DocumentNode,
  mediaType: string,
  parameter = false,
): Type {
  const media = isRecord(node.value) ? node.value : {}
  const kind = classifyMediaType(mediaType)
  const schema = (): Type =>
    "schema" in media ? schemas.type(schemas.context.documents.child(node, "schema")) : UNKNOWN
  if (parameter) return kind === "json" ? schema() : STRING

  if ("itemSchema" in media) {
    // A 3.2 field, applied in earlier versions too.
    if (kind === "events" || kind === "sequence") {
      return {
        kind: "array",
        items: schemas.type(schemas.context.documents.child(node, "itemSchema")),
      }
    }
    schemas.context.warn(
      "ignored-field",
      `"itemSchema" is not applied: ${mediaType} is not a sequential media type`,
      node,
      "itemSchema",
    )
  }

  switch (kind) {
    case "json":
    case "form":
    case "multipart":
      return schema()
    case "sequence":
      return "schema" in media ? schema() : { kind: "array", items: UNKNOWN }
    case "events":
    case "text":
      // Text is a string; a schema that says which strings keeps them, and
      // types the JSON that `text/*` may also be (`text/json`) the same.
      return "schema" in media &&
        describesStrings(schemas, schemas.context.documents.child(node, "schema"))
        ? schema()
        : isTextRange(mediaType)
          ? UNKNOWN
          : STRING
    case "binary":
      return BLOB
  }
}

/**
 * Whether a schema says its values are text strings: `type: string`, or string `enum`/`const`
 * values.
 */
function describesStrings(schemas: SchemaBuilder, node: DocumentNode): boolean {
  const target = schemas.aliasTarget(node) ?? node
  const schema = target.value
  if (!isRecord(schema) || describesRawBytes(target)) return false
  if (schema.type !== undefined) return schema.type === "string"
  const values = Array.isArray(schema.enum) ? schema.enum : "const" in schema ? [schema.const] : []
  return values.length > 0 && values.every((v) => typeof v === "string")
}
