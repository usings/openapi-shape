import type { BuildContext } from "./build-context"
import type { DocumentNode } from "./documents"
import { classifyMediaType, isFormData, isTextRange } from "./media-types"
import type { Encoding, Operation, Type } from "./model"
import { UNKNOWN, childTypes } from "./model"
import { isRecord } from "./object"
import type { SchemaBuilder } from "./schemas"
import { describesRawBytes } from "./schemas"

const BLOB: Type = { kind: "binary" }
const STRING: Type = { kind: "string" }

/**
 * The type of one Media Type Object's content, by the class of its media type
 * (`classifyMediaType`): JSON, form, and multipart content is typed by its schema; a sequence
 * (`itemSchema`, or a JSON sequence's `schema`) is an array of its items; other text is a string,
 * or the schema's type when it says which strings (`unknown` under `text/*`, which may be JSON);
 * anything else is raw bytes, a `Blob`. A parameter's content is typed by its schema when it is
 * JSON, and as a string otherwise.
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
      // Before `itemSchema` existed, documents typed each item by `schema`.
      if (!("schema" in media)) return { kind: "array", items: UNKNOWN }
      return { kind: "array", items: schema() }
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

/** Report the gap between advertised Blob values and the client's automatic request encoders. */
export function diagnoseRequestEncodings(context: BuildContext, operations: Operation[]): void {
  for (const operation of operations) {
    const method = operation.key.split(" ", 1)[0].toUpperCase()
    if (["CONNECT", "TRACE", "TRACK"].includes(method)) continue
    // Cookies are browser-managed; the client does not encode them.
    const parameters = [...operation.params, ...operation.query, ...operation.headers]
    if (operation.querystring) parameters.push({ name: "querystring", ...operation.querystring })
    for (const parameter of parameters) {
      if (!hasUnsupportedBlob(parameter.type, "encoded")) continue
      context.diagnostics.warn(
        "unsupported-request-encoding",
        `Parameter "${parameter.name}" advertises Blob values that the client cannot encode as parameter text. Use a textual schema/value, such as base64 with contentEncoding, and encode the bytes before calling the client`,
        parameter.location ?? "#",
      )
    }
    // These methods cannot send any body through fetch, including a ready one.
    if (method === "GET" || method === "HEAD") continue
    for (const media of operation.body?.content ?? []) {
      const kind = classifyMediaType(media.mediaType)
      if (kind !== "json" && kind !== "form" && !isFormData(media.mediaType)) continue
      const multipart = kind === "multipart"
      if (!hasUnsupportedBlob(media.type, multipart ? "multipart" : "body", media.encoding))
        continue
      context.diagnostics.warn(
        "unsupported-request-encoding",
        multipart
          ? "Multipart content advertises nested Blob values or styled binary fields that the client cannot encode. Use raw file fields or pass a ready FormData body"
          : `${media.mediaType} content advertises nested Blob values that the client cannot encode. Represent bytes as strings (for example base64 with contentEncoding), or pass a ready encoded body`,
        media.location ?? "#",
      )
    }
  }
}

type BinaryPosition = "body" | "multipart" | "part" | "item" | "encoded"

/** A ready body or raw multipart part accepts Blob; JSON/text serialization at any depth does not. */
function hasUnsupportedBlob(
  type: Type,
  position: BinaryPosition,
  encodings?: Record<string, Encoding>,
  seen = new Map<Type, Set<BinaryPosition>>(),
): boolean {
  const visited = seen.get(type) ?? new Set<BinaryPosition>()
  if (visited.has(position)) return false
  visited.add(position)
  seen.set(type, visited)
  if (type.kind === "binary") return position === "encoded"
  const visit = (child: Type, at: BinaryPosition): boolean =>
    hasUnsupportedBlob(child, at, encodings, seen)
  if (type.kind === "ref") return visit(type.target.type, position)
  if (type.kind === "union" || type.kind === "intersection" || type.kind === "narrow") {
    return childTypes(type).some((child) => visit(child, position))
  }
  if (type.kind === "object" && position === "multipart") {
    return (
      type.fields.some((field) => {
        const spec =
          encodings && Object.hasOwn(encodings, field.name) ? encodings[field.name] : undefined
        const styled =
          spec?.style !== undefined ||
          spec?.explode !== undefined ||
          spec?.allowReserved !== undefined
        return visit(field.type, styled ? "encoded" : "part")
      }) ||
      (type.additional !== undefined && visit(type.additional, "part")) ||
      (type.patterns ?? []).some((pattern) => visit(pattern.type, "part"))
    )
  }
  const nested =
    position === "part" && (type.kind === "array" || type.kind === "tuple") ? "item" : "encoded"
  return childTypes(type).some((child) => visit(child, nested))
}
