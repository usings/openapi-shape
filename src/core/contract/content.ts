import type { Node } from "../openapi/documents"
import { classifyMediaType } from "../shared/media"
import { isRecord } from "../shared/object"
import { intersect, union } from "./algebra"
import type { Field, Type } from "./model"
import { UNKNOWN } from "./model"
import { identity } from "./nodes"
import type { SchemaBuilder } from "./schema"
import { describesRawBytes } from "./schema"

const BLOB: Type = { kind: "binary" }
const STRING: Type = { kind: "string" }
/** A server-sent event as openapi-shape/client decodes it (HTML Standard, "Server-sent events"). */
const EVENT: Type = {
  kind: "object",
  fields: [
    { name: "data", type: STRING, required: true },
    { name: "event", type: STRING, required: false },
    { name: "id", type: STRING, required: false },
    { name: "retry", type: { kind: "number" }, required: false },
  ],
}

/** Where content appears: the client encodes requests and parameters, and decodes responses. */
export type ContentUse = "request" | "response" | "parameter"

/**
 * The type of one Media Type Object's content: what openapi-shape/client
 * sends or returns for it, by the classes of `classifyMediaType`. JSON is
 * typed by its schema; event streams and JSON sequences are arrays of items;
 * other text is a string; form and multipart requests are typed by their
 * schemas; everything else (and every form or multipart response) is raw bytes.
 */
export function mediaContentType(
  builder: SchemaBuilder,
  node: Node,
  mediaType: string,
  use: ContentUse,
): Type {
  const media = isRecord(node.value) ? node.value : {}
  const kind = classifyMediaType(mediaType)
  const schema = (): Type =>
    "schema" in media ? builder.type(builder.docs.child(node, "schema")) : UNKNOWN
  if (use === "parameter") return kind === "json" ? schema() : STRING
  // The client decodes event streams; it sends them only ready-made.
  if (kind === "events" && use === "request") return BLOB

  const sequential = kind === "events" || kind === "sequence"
  if ("itemSchema" in media) {
    if (!sequential) {
      builder.warn(
        "ignored-keyword",
        `"itemSchema" is not applied: openapi-shape/client does not read ${mediaType} as a sequence`,
        node,
        "itemSchema",
      )
    } else {
      if (node.doc.version !== "3.2") {
        builder.warn(
          "lenient-keyword",
          '"itemSchema" requires OpenAPI 3.2; applied anyway',
          node,
          "itemSchema",
        )
      }
      const items: Type = {
        kind: "array",
        items: builder.type(builder.docs.child(node, "itemSchema")),
      }
      return "schema" in media ? intersect([schema(), items]) : items
    }
  }

  switch (kind) {
    case "json":
      // Raw bytes under a wildcard come as the server labels them: the client
      // decodes a binary response to a Blob, and text to a string.
      if (use === "response" && wildcard(mediaType) && rawBytes(builder, node)) {
        return union([schema(), STRING])
      }
      return schema()
    case "events":
      if ("schema" in media) {
        builder.warn(
          "ignored-keyword",
          '"schema" of text/event-stream is not applied: events are typed as the client decodes them, with their data as text; "itemSchema" (OpenAPI 3.2) types them',
          node,
          "schema",
        )
      }
      return { kind: "array", items: EVENT }
    case "sequence":
      if (!("schema" in media)) return { kind: "array", items: UNKNOWN }
      builder.warn(
        "lenient-keyword",
        `"schema" of ${mediaType} is read as the type of each item, as "itemSchema" (OpenAPI 3.2) declares it`,
        node,
        "schema",
      )
      return { kind: "array", items: schema() }
    case "text":
      // Text arrives as a string; a schema that says which strings keeps them.
      return "schema" in media && describesStrings(builder, builder.docs.child(node, "schema"))
        ? schema()
        : STRING
    case "form":
      return use === "request" ? schema() : BLOB
    case "multipart":
      if (use !== "request") return BLOB
      return "schema" in media
        ? multipartType(builder, node, builder.docs.child(node, "schema"))
        : UNKNOWN
    case "binary":
      return BLOB
  }
}

function wildcard(mediaType: string): boolean {
  return mediaType.split(";", 1)[0].includes("*")
}

/** Whether a media type's schema is raw bytes (a `Blob` in the schema). */
function rawBytes(builder: SchemaBuilder, media: Node): boolean {
  if (!isRecord(media.value) || !("schema" in media.value)) return false
  return mayBeRawBytes(builder, builder.docs.child(media, "schema"), new Set())
}

/** Whether a schema is raw bytes, or has raw bytes among its `oneOf`/`anyOf` alternatives. */
function mayBeRawBytes(builder: SchemaBuilder, node: Node, seen: Set<string>): boolean {
  const target = builder.aliasTarget(node) ?? node
  const schema = target.value
  if (seen.has(identity(target))) return false
  seen.add(identity(target))
  if (describesRawBytes(target)) return true
  if (!isRecord(schema)) return false
  return ["oneOf", "anyOf"].some((keyword) => {
    const members = schema[keyword]
    return (
      Array.isArray(members) &&
      members.some((_, i) => mayBeRawBytes(builder, builder.docs.child(target, keyword, i), seen))
    )
  })
}

/** Whether a schema says its values are text strings: `type: string`, or string `enum`/`const` values. */
function describesStrings(builder: SchemaBuilder, node: Node): boolean {
  const target = builder.aliasTarget(node) ?? node
  const schema = target.value
  if (!isRecord(schema) || describesRawBytes(target)) return false
  if (schema.type !== undefined) return schema.type === "string"
  const values = Array.isArray(schema.enum) ? schema.enum : "const" in schema ? [schema.const] : []
  return values.length > 0 && values.every((v) => typeof v === "string")
}

/** A schema that does not say what kind of value it is (annotations, format, content keywords). */
function isEmptySchema(schema: unknown): boolean {
  return schema === true || (isRecord(schema) && Object.keys(schema).every((k) => !TYPED.has(k)))
}

const TYPED = new Set([
  "$ref",
  "$dynamicRef",
  "type",
  "enum",
  "const",
  "properties",
  "patternProperties",
  "additionalProperties",
  "required",
  "items",
  "prefixItems",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
])

/**
 * Multipart parts that are files but not typed so: an untyped part is laid
 * over the schema's type as a `Blob` (`Blob[]` for arrays); a text part an
 * Encoding Object names a binary media type for is replaced by one in the
 * body's own objects. Raw bytes are Blobs already.
 */
function multipartType(builder: SchemaBuilder, media: Node, schema: Node): Type {
  const encoding =
    isRecord(media.value) && isRecord(media.value.encoding) ? media.value.encoding : {}
  const body = builder.aliasTarget(schema) ?? schema
  const shapes = new Map<string, PartShape[]>()
  const text = new Set<string>()
  const referenced = new Set<string>()
  for (const [name, property, viaReference] of partNodes(builder, body, false, new Set())) {
    const entry = encoding[name]
    const declared =
      isRecord(entry) && typeof entry.contentType === "string" ? entry.contentType : undefined
    const shape = partShape(builder, property, declared)
    shapes.set(name, [...(shapes.get(name) ?? []), shape])
    if (shape !== "value" && isText(builder, property)) {
      text.add(name)
      if (viaReference) referenced.add(name)
    }
  }
  // A part is a file where every schema that declares it says so.
  const files: Field[] = []
  for (const [name, found] of shapes) {
    if (found.every((shape) => shape === "file")) files.push({ name, type: BLOB, required: false })
    if (found.every((shape) => shape === "files")) {
      files.push({ name, type: { kind: "array", items: BLOB }, required: false })
    }
  }
  // A text part cannot be narrowed to a Blob (`string & Blob` admits none). It
  // is replaced where only the body's own objects declare it; one a referenced
  // schema declares, too, stays text, and says so.
  const retyped: Field[] = []
  for (const file of files.filter((f) => text.has(f.name))) {
    if (!referenced.has(file.name)) retyped.push(file)
    else textPart(builder, media, file.name)
  }
  let type = builder.type(retyped.length > 0 ? body : schema)
  if (retyped.length > 0) {
    const replaced = new Set<string>()
    type = replaceFields(type, retyped, replaced)
    for (const file of retyped) if (!replaced.has(file.name)) textPart(builder, media, file.name)
  }
  // A Blob narrows an untyped part, also in a named schema.
  const untyped = files.filter((file) => !text.has(file.name))
  return untyped.length === 0 ? type : intersect([type, { kind: "object", fields: untyped }])
}

function textPart(builder: SchemaBuilder, media: Node, name: string): void {
  builder.warn(
    "ignored-keyword",
    `The Encoding Object makes part "${name}" a file, but a schema it extends types the part as text, so it stays text; to send a file, pass a FormData body`,
    builder.docs.child(media, "encoding"),
    name,
  )
}

/** The type with these fields' types replaced in its own objects; `replaced` collects their names. */
function replaceFields(type: Type, files: Field[], replaced: Set<string>): Type {
  switch (type.kind) {
    case "object":
      return {
        ...type,
        fields: type.fields.map((field) => {
          const file = files.find((f) => f.name === field.name)
          if (file === undefined) return field
          replaced.add(field.name)
          return { ...field, type: file.type }
        }),
      }
    case "intersection":
      return intersect(type.members.map((member) => replaceFields(member, files, replaced)))
    case "union":
      return union(type.members.map((member) => replaceFields(member, files, replaced)))
    case "narrow":
      return { ...type, type: replaceFields(type.type, files, replaced) }
    default:
      return type
  }
}

/** Whether a part's schema is text: a string that is not raw bytes. */
function isText(builder: SchemaBuilder, property: Node): boolean {
  const target = builder.aliasTarget(property) ?? property
  const schema = target.value
  if (!isRecord(schema)) return false
  if (schema.type === "array") return isText(builder, builder.docs.child(target, "items"))
  const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type]
  const text = types.includes("string") && types.every((t) => t === "string" || t === "null")
  return text && !describesRawBytes(target)
}

/**
 * The properties of an object schema, also those its `allOf` members,
 * alternatives, and `if`/`then`/`else` declare, each with whether it was
 * reached through a reference.
 */
function partNodes(
  builder: SchemaBuilder,
  node: Node,
  viaReference: boolean,
  seen: Set<string>,
): Array<[string, Node, boolean]> {
  const target = builder.aliasTarget(node) ?? node
  const schema = target.value
  const via = viaReference || target !== node
  // A schema reached both directly and through a reference is walked both ways.
  const key = `${via}:${identity(target)}`
  if (!isRecord(schema) || seen.has(key)) return []
  seen.add(key)
  const out: Array<[string, Node, boolean]> = []
  if (isRecord(schema.properties)) {
    for (const name of Object.keys(schema.properties)) {
      out.push([name, builder.docs.child(target, "properties", name), via])
    }
  }
  // A reference with siblings (3.1+), or a $dynamicRef, extends the schema it names.
  for (const keyword of ["$ref", "$dynamicRef"]) {
    const ref = schema[keyword]
    const extended = typeof ref === "string" ? builder.docs.resolve(ref, target) : undefined
    if (extended?.kind === "found") out.push(...partNodes(builder, extended.node, true, seen))
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const members = schema[keyword]
    if (!Array.isArray(members)) continue
    members.forEach((_, i) => {
      out.push(...partNodes(builder, builder.docs.child(target, keyword, i), via, seen))
    })
  }
  // The schema's type applies `if`/`then`/`else` when it has `if` and `else`.
  if ("if" in schema && "else" in schema) {
    for (const keyword of ["if", "then", "else"]) {
      if (keyword in schema) {
        out.push(...partNodes(builder, builder.docs.child(target, keyword), via, seen))
      }
    }
  }
  return out
}

type PartShape = "file" | "files" | "value"

/**
 * Whether a multipart part is a file not typed as one: its Encoding Object
 * names a binary media type for an untyped or text part, or, without one, its
 * schema says nothing about the value's type (the default part type is then
 * `application/octet-stream`).
 */
function partShape(builder: SchemaBuilder, property: Node, declared?: string): PartShape {
  const target = builder.aliasTarget(property) ?? property
  const schema = target.value
  if (isRecord(schema) && schema.type === "array") {
    const items = partShape(builder, builder.docs.child(target, "items"), declared)
    return items === "file" ? "files" : "value"
  }
  const untyped = isEmptySchema(schema)
  if (declared !== undefined) {
    const binary = declared.split(",").every((t) => classifyMediaType(t.trim()) === "binary")
    return binary && (untyped || isText(builder, property)) ? "file" : "value"
  }
  return untyped ? "file" : "value"
}
