import { selectContentSource } from "./content-sources"
import type { DocumentNode } from "./documents"
import type { TypeNode } from "./model"
import { UNKNOWN } from "./model"
import type { SchemaBuilder } from "./schemas"

const BLOB: TypeNode = { kind: "blob" }
const STRING: TypeNode = { kind: "string" }

/**
 * The type of one Media TypeNode Object's content, by the class of its media type
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
): TypeNode {
  const { source, ignoredItemSchema } = selectContentSource(
    schemas.context.documents,
    node,
    mediaType,
    parameter,
  )
  if (ignoredItemSchema) {
    schemas.context.warn(
      "ignored-field",
      `"itemSchema" is not applied: ${mediaType} is not a sequential media type`,
      node,
      "itemSchema",
    )
  }

  switch (source.kind) {
    case "schema":
      return schemas.type(source.node)
    case "items":
      return { kind: "array", items: schemas.type(source.node) }
    case "array":
      return { kind: "array", items: UNKNOWN }
    case "unknown":
      return UNKNOWN
    case "string":
      return STRING
    case "unresolved":
      return source.fallback === "unknown" ? UNKNOWN : STRING
    case "blob":
      return BLOB
  }
}
