import type { DocBlock, PrimitiveName } from "../contract/contract"
import { docBlock } from "../contract/doc"
import type { OpenAPISchema, OpenAPISchemaObject } from "../contract/openapi"
import { schemaNameFromRef } from "../contract/schema-ref"
import { objectIndexSchemas } from "../contract/shapes"
import { safeIdentifier } from "../shared/naming"
import { isObjectAdditional } from "../shared/object"
import type { DeclarationOptions } from "./options"

/**
 * Primitive emitted by the declaration renderer. `undefined` exists only here
 * to widen index signatures; the contract IR never produces it.
 */
export type DeclarationPrimitive = PrimitiveName | "undefined"

/** Renderer-friendly TypeScript AST produced from normalized schemas. */
export type TypeNode =
  | { kind: "primitive"; name: DeclarationPrimitive }
  | { kind: "literal"; value: string | number | boolean | null }
  /** Reference to a named schema. Renderers may prepend a namespace prefix. */
  | { kind: "ref"; name: string }
  | { kind: "array"; items: TypeNode }
  | { kind: "tuple"; items: TypeNode[]; rest: TypeNode | null }
  | { kind: "object"; fields: TypeField[]; index: TypeNode | null }
  /** `Record<string, T>` object shape used when an object has no declared properties. */
  | { kind: "record"; values: TypeNode }
  | { kind: "union"; members: TypeNode[] }
  | { kind: "intersection"; members: TypeNode[] }
  /** Raw TypeScript supplied by options, such as custom `format` mappings. */
  | { kind: "raw"; text: string }

export interface TypeField {
  name: string
  required: boolean
  type: TypeNode
  docs?: DocBlock
}

/**
 * Convert a supported OpenAPI schema into the declaration type AST.
 *
 * Unknown, empty, or unsupported schema shapes become `unknown`; empty enums and
 * empty unions become `never`; `allOf` becomes an intersection; `oneOf` and
 * `anyOf` become deduplicated unions.
 */
export function schemaToTypeNode(
  schema: OpenAPISchema | undefined,
  options: DeclarationOptions,
): TypeNode {
  if (schema === undefined || schema === true) return primitiveNode("unknown")
  if (schema === false) return primitiveNode("never")
  if (isEmptySchema(schema)) return primitiveNode("unknown")

  if (schema.oneOf || schema.anyOf || schema.allOf) {
    return compositionToTypeNode(schema, options)
  }

  if ("const" in schema) return constToTypeNode(schema.const)

  if (Array.isArray(schema.type)) return typeArrayToNode(schema, options)

  if (Array.isArray(schema.enum)) return enumToNode(schema.enum)

  if (schema.$ref) {
    return { kind: "ref", name: safeIdentifier(schemaNameFromRef(schema.$ref)) }
  }

  return convertSingleType(schema, options)
}

/**
 * Convert `oneOf`/`anyOf`/`allOf` plus any meaningful sibling keywords.
 *
 * JSON Schema applies composition keywords alongside sibling constraints, so
 * sibling `properties`, `items`, and scalar types join the intersection instead
 * of being dropped.
 */
function compositionToTypeNode(schema: OpenAPISchemaObject, options: DeclarationOptions): TypeNode {
  const members: TypeNode[] = []
  if (schema.allOf) {
    members.push(...schema.allOf.map((b) => schemaToTypeNode(b, options)))
  }
  for (const branches of [schema.oneOf, schema.anyOf]) {
    if (!branches) continue
    if (branches.length === 0) return primitiveNode("never")
    members.push(uniqueUnion(branches.map((b) => schemaToTypeNode(b, options))))
  }
  const sibling = compositionSiblingNode(schema, options)
  if (sibling) members.push(sibling)
  if (members.length === 0) return primitiveNode("unknown")
  if (members.length === 1) return members[0]
  return { kind: "intersection", members }
}

function compositionSiblingNode(
  schema: OpenAPISchemaObject,
  options: DeclarationOptions,
): TypeNode | null {
  const { oneOf: _o, anyOf: _a, allOf: _l, discriminator: _d, ...rest } = schema
  if (
    Array.isArray(rest.type) ||
    Array.isArray(rest.enum) ||
    "const" in rest ||
    rest.$ref !== undefined
  ) {
    return schemaToTypeNode(rest, options)
  }
  const hasObjectContent =
    rest.properties !== undefined ||
    rest.patternProperties !== undefined ||
    isObjectAdditional(rest.additionalProperties)
  if (hasObjectContent) return schemaToTypeNode({ ...rest, type: "object" }, options)
  if (rest.type === "array" || rest.items !== undefined || rest.prefixItems !== undefined) {
    return schemaToTypeNode({ ...rest, type: "array" }, options)
  }
  if (typeof rest.type === "string" && rest.type !== "object") {
    return schemaToTypeNode(rest, options)
  }
  return null
}

export function primitiveNode(name: DeclarationPrimitive): TypeNode {
  return { kind: "primitive", name }
}

function isEmptySchema(s: OpenAPISchemaObject): boolean {
  return (
    s.type === undefined &&
    !s.$ref &&
    !s.oneOf &&
    !s.anyOf &&
    !s.allOf &&
    !s.enum &&
    !("const" in s)
  )
}

function typeArrayToNode(schema: OpenAPISchemaObject, options: DeclarationOptions): TypeNode {
  const types = schema.type as string[]
  const nonNull = types.filter((t) => t !== "null")
  const includesNull = types.includes("null")

  // `enum` constrains the type array and must explicitly include `null`.
  if (Array.isArray(schema.enum)) return enumToNode(schema.enum)

  if (
    schema.format !== undefined &&
    options.formats &&
    Object.hasOwn(options.formats, schema.format) &&
    nonNull.length === 1 &&
    isFormatMappablePrimitive(nonNull[0])
  ) {
    const mapped: TypeNode = { kind: "raw", text: options.formats[schema.format] }
    return includesNull ? { kind: "union", members: [mapped, primitiveNode("null")] } : mapped
  }

  const inner: TypeNode[] = nonNull.map((t) => convertSingleType({ ...schema, type: t }, options))
  if (includesNull) inner.push(primitiveNode("null"))
  if (inner.length === 1) return inner[0]
  return { kind: "union", members: inner }
}

function convertSingleType(schema: OpenAPISchemaObject, options: DeclarationOptions): TypeNode {
  const t = typeof schema.type === "string" ? schema.type : undefined

  if (
    schema.format !== undefined &&
    options.formats &&
    Object.hasOwn(options.formats, schema.format) &&
    (t === undefined || isFormatMappablePrimitive(t))
  ) {
    return { kind: "raw", text: options.formats[schema.format] }
  }

  if (
    (t === "string" || t === undefined) &&
    (schema.format === "binary" || schema.format === "byte")
  ) {
    return primitiveNode("Blob")
  }

  if (t === "array") return arrayToNode(schema, options)
  if (t === "object") return objectToNode(schema, options)
  if (t === undefined) return primitiveNode("unknown")
  return primitiveStringToNode(t)
}

function arrayToNode(schema: OpenAPISchemaObject, options: DeclarationOptions): TypeNode {
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((it) => schemaToTypeNode(it, options))
    let rest: TypeNode | null = null
    if (schema.items === true) rest = primitiveNode("unknown")
    else if (schema.items && typeof schema.items === "object")
      rest = schemaToTypeNode(schema.items, options)
    return { kind: "tuple", items, rest }
  }
  const items =
    typeof schema.items === "object" && schema.items !== null
      ? schemaToTypeNode(schema.items, options)
      : primitiveNode("unknown")
  return { kind: "array", items }
}

function objectToNode(schema: OpenAPISchemaObject, options: DeclarationOptions): TypeNode {
  const index = objectIndexNode(schema, options)
  if (!schema.properties) {
    return { kind: "record", values: index ?? primitiveNode("unknown") }
  }
  const required = new Set<string>(schema.required ?? [])
  const fields: TypeField[] = Object.entries(schema.properties).map(([name, value]) => ({
    name,
    required: required.has(name),
    type: schemaToTypeNode(value, options),
    docs: docBlock(value),
  }))
  return { kind: "object", fields, index: index ? widenIndexNode(index, fields) : null }
}

/**
 * Include every declared property type in an index signature, as required by
 * TypeScript. Optional properties also contribute `undefined`.
 */
export function widenIndexNode(index: TypeNode, fields: TypeField[]): TypeNode {
  if (index.kind === "primitive" && index.name === "unknown") return index
  const members: TypeNode[] = [
    ...(index.kind === "union" ? index.members : [index]),
    ...fields.map((f) => f.type),
  ]
  if (fields.some((f) => !f.required)) members.push(primitiveNode("undefined"))
  return uniqueUnion(members)
}

/**
 * Combine `patternProperties` and schema-valued `additionalProperties` into an
 * index-signature value type.
 */
export function objectIndexNode(
  schema: OpenAPISchemaObject,
  options: DeclarationOptions,
): TypeNode | null {
  const values = objectIndexSchemas(schema).map((s) => schemaToTypeNode(s, options))
  if (values.length === 0) return null
  if (values.length === 1) return values[0]
  return { kind: "union", members: values }
}

function isFormatMappablePrimitive(t: string): boolean {
  return t === "string" || t === "number" || t === "integer"
}

function primitiveStringToNode(t: string): TypeNode {
  switch (t) {
    case "string":
      return primitiveNode("string")
    case "number":
    case "integer":
      return primitiveNode("number")
    case "boolean":
      return primitiveNode("boolean")
    case "null":
      return primitiveNode("null")
    default:
      return primitiveNode("unknown")
  }
}

function enumToNode(values: unknown[]): TypeNode {
  if (values.length === 0) return primitiveNode("never")
  const members = values.map((v) => constToTypeNode(v))
  return uniqueUnion(members)
}

function constToTypeNode(value: unknown): TypeNode {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return { kind: "literal", value }
  }
  return primitiveNode("unknown")
}

function uniqueUnion(members: TypeNode[]): TypeNode {
  const seen = new Set<string>()
  const dedup: TypeNode[] = []
  for (const m of members) {
    const key = JSON.stringify(m)
    if (seen.has(key)) continue
    seen.add(key)
    dedup.push(m)
  }
  if (dedup.length === 1) return dedup[0]
  return { kind: "union", members: dedup }
}
