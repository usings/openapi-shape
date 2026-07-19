import { schemaNameFromRef } from "../openapi/schema-ref"
import type { OpenAPISchema, OpenAPISchemaObject } from "../openapi/types"
import { safeIdentifier } from "../shared/naming"
import { isObjectAdditional } from "../shared/object"
import { docBlock } from "./doc"
import type { ContractField, ContractType, ScalarName } from "./model"

/**
 * Convert a supported OpenAPI schema into the language-neutral contract type.
 *
 * Unknown, empty, or unsupported schema shapes become `unknown`; `false` and
 * empty enums or unions become `never`; `allOf` becomes an intersection; and
 * `oneOf`/`anyOf` become unions. Scalars keep their declared `format` so
 * renderers can apply user format mappings.
 */
export function buildContractType(schema: OpenAPISchema | undefined): ContractType {
  if (schema === undefined || schema === true) return { kind: "unknown" }
  if (schema === false) return { kind: "never" }
  if (isEmptySchema(schema)) return { kind: "unknown" }

  if (schema.oneOf || schema.anyOf || schema.allOf) return compositionType(schema)

  if ("const" in schema) return constType(schema.const)

  if (Array.isArray(schema.type)) return typeArrayType(schema)

  if (Array.isArray(schema.enum)) return enumType(schema.enum)

  if (schema.$ref) {
    return { kind: "reference", name: safeIdentifier(schemaNameFromRef(schema.$ref)) }
  }

  return singleType(schema)
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

/**
 * Convert `oneOf`/`anyOf`/`allOf` plus any meaningful sibling keywords.
 *
 * JSON Schema applies composition keywords alongside sibling constraints, so
 * sibling `properties`, `items`, and scalar types join the intersection instead
 * of being dropped.
 */
function compositionType(schema: OpenAPISchemaObject): ContractType {
  const members: ContractType[] = []
  if (schema.allOf) {
    members.push(...schema.allOf.map((b) => buildContractType(b)))
  }
  for (const branches of [schema.oneOf, schema.anyOf]) {
    if (!branches) continue
    if (branches.length === 0) return { kind: "never" }
    members.push(unionOf(branches.map((b) => buildContractType(b))))
  }
  const sibling = compositionSiblingType(schema)
  if (sibling) members.push(sibling)
  if (members.length === 0) return { kind: "unknown" }
  if (members.length === 1) return members[0]
  return { kind: "intersection", members }
}

function compositionSiblingType(schema: OpenAPISchemaObject): ContractType | null {
  const { oneOf: _o, anyOf: _a, allOf: _l, discriminator: _d, ...rest } = schema
  if (
    Array.isArray(rest.type) ||
    Array.isArray(rest.enum) ||
    "const" in rest ||
    rest.$ref !== undefined
  ) {
    return buildContractType(rest)
  }
  const hasObjectContent =
    rest.properties !== undefined ||
    rest.patternProperties !== undefined ||
    isObjectAdditional(rest.additionalProperties)
  if (hasObjectContent) return buildContractType({ ...rest, type: "object" })
  if (rest.type === "array" || rest.items !== undefined || rest.prefixItems !== undefined) {
    return buildContractType({ ...rest, type: "array" })
  }
  if (typeof rest.type === "string" && rest.type !== "object") {
    return buildContractType(rest)
  }
  return null
}

function typeArrayType(schema: OpenAPISchemaObject): ContractType {
  const types = schema.type as string[]
  const nonNull = types.filter((t) => t !== "null")
  const includesNull = types.includes("null")

  // `enum` constrains the type array and must explicitly include `null`.
  if (Array.isArray(schema.enum)) return enumType(schema.enum)

  const inner: ContractType[] = nonNull.map((t) => singleType({ ...schema, type: t }))
  if (includesNull) inner.push({ kind: "scalar", name: "null" })
  if (inner.length === 1) return inner[0]
  return { kind: "union", members: inner }
}

function singleType(schema: OpenAPISchemaObject): ContractType {
  const t = typeof schema.type === "string" ? schema.type : undefined

  if (
    (t === "string" || t === undefined) &&
    (schema.format === "binary" || schema.format === "byte")
  ) {
    return { kind: "binary", format: schema.format }
  }

  if (t === "array") return arrayType(schema)
  if (t === "object") return objectType(schema)
  if (t === undefined) return { kind: "unknown" }
  return scalarType(t, schema.format)
}

function scalarType(t: string, format: string | undefined): ContractType {
  let name: ScalarName
  switch (t) {
    case "string":
    case "boolean":
    case "null":
      name = t
      break
    case "number":
    case "integer":
      name = "number"
      break
    default:
      return { kind: "unknown" }
  }
  return format !== undefined ? { kind: "scalar", name, format } : { kind: "scalar", name }
}

function arrayType(schema: OpenAPISchemaObject): ContractType {
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((it) => buildContractType(it))
    let rest: ContractType | undefined
    if (schema.items === true) rest = { kind: "unknown" }
    else if (schema.items && typeof schema.items === "object") {
      rest = buildContractType(schema.items)
    }
    return rest ? { kind: "tuple", items, rest } : { kind: "tuple", items }
  }
  const items =
    typeof schema.items === "object" && schema.items !== null
      ? buildContractType(schema.items)
      : ({ kind: "unknown" } as const)
  return { kind: "array", items }
}

function objectType(schema: OpenAPISchemaObject): ContractType {
  const index = objectIndexType(schema)
  if (!schema.properties) {
    return { kind: "record", values: index ?? { kind: "unknown" } }
  }
  const required = new Set<string>(schema.required ?? [])
  const fields: ContractField[] = Object.entries(schema.properties).map(([name, value]) => {
    const field: ContractField = {
      name,
      required: required.has(name),
      type: buildContractType(value),
    }
    const docs = docBlock(value)
    if (docs !== undefined) field.docs = docs
    return field
  })
  return index ? { kind: "object", fields, index } : { kind: "object", fields }
}

/**
 * Combine `patternProperties` and schema-valued `additionalProperties` into an
 * unwidened index value type. Renderers widen it with declared field types as
 * required by TypeScript index signatures.
 */
export function objectIndexType(schema: OpenAPISchemaObject): ContractType | null {
  if (schema.additionalProperties === true) return { kind: "unknown" }
  const values: OpenAPISchema[] = []
  if (schema.patternProperties) values.push(...Object.values(schema.patternProperties))
  if (isObjectAdditional<OpenAPISchemaObject>(schema.additionalProperties)) {
    values.push(schema.additionalProperties)
  }
  if (values.length === 0) return null
  return unionOf(values.map((v) => buildContractType(v)))
}

function enumType(values: unknown[]): ContractType {
  if (values.length === 0) return { kind: "never" }
  const seen = new Set<string>()
  const members: ContractType[] = []
  for (const value of values) {
    const member = constType(value)
    const key = JSON.stringify(member)
    if (seen.has(key)) continue
    seen.add(key)
    members.push(member)
  }
  return unionOf(members)
}

function constType(value: unknown): ContractType {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return { kind: "literal", value }
  }
  return { kind: "unknown" }
}

function unionOf(members: ContractType[]): ContractType {
  if (members.length === 1) return members[0]
  return { kind: "union", members }
}
