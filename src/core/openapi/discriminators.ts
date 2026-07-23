import { isObject } from "../shared/object"
import { appendPointer } from "../shared/pointer"
import { LoadError } from "./errors"
import { schemaNameFromRef } from "./schema-ref"
import { isSchemaObject } from "./types"
import type { OpenAPIDocument, OpenAPISchema, OpenAPISchemaObject } from "./types"
import { mapDocumentSchemas } from "./walk"

/** Discriminator literal to inject into one referenced component schema. */
export interface Injection {
  schemaName: string
  propertyName: string
  value: string
  /** Branch location used in conflict diagnostics. */
  sourceLocation: string
}

type ReducedInjection = Pick<Injection, "value" | "sourceLocation">

/** Injections grouped first by component schema, then by discriminator property. */
export type SchemaInjections = Map<string, Map<string, ReducedInjection>>

/**
 * Discover, validate, and apply discriminator literal properties to schemas.
 *
 * OpenAPI discriminators identify branches externally. TypeScript unions narrow
 * better when each branch schema carries a required string literal property, so
 * this preparation step materializes those literals before contract building.
 */
export function injectDiscriminators(doc: OpenAPIDocument): OpenAPIDocument {
  const normalized = normalizeInlineDiscriminators(doc)
  return applyInjections(normalized, reduceInjections(discoverInjections(normalized)))
}

/**
 * Make an inline discriminator branch narrowable when it already declares one
 * unambiguous string literal for the discriminator property.
 *
 * Unlike referenced component branches, inline branches have no schema name or
 * mapping target from which a discriminator value can be inferred. Branches
 * without an existing single-value `const`/`enum` are therefore left unchanged.
 */
export function normalizeInlineDiscriminators(doc: OpenAPIDocument): OpenAPIDocument {
  return mapDocumentSchemas(doc, normalizeInlineBranches)
}

function normalizeInlineBranches(schema: OpenAPISchema): OpenAPISchema {
  if (!isSchemaObject(schema)) return schema
  const propertyName = schema.discriminator?.propertyName
  if (typeof propertyName !== "string") return schema

  const selected = discriminatorBranches(schema)
  if (!selected) return schema

  const [key, original] = selected
  const branches = original.map((branch) => requireInlineLiteral(branch, propertyName))
  const changed = branches.some((branch, index) => branch !== original[index])
  return changed ? { ...schema, [key]: branches } : schema
}

function requireInlineLiteral(branch: OpenAPISchema, propertyName: string): OpenAPISchema {
  if (!isSchemaObject(branch)) return branch
  if (branch.$ref) return branch
  const property = branch.properties?.[propertyName]
  if (!hasSingleStringLiteral(property)) return branch
  if (branch.required?.includes(propertyName)) return branch
  return { ...branch, required: [...(branch.required ?? []), propertyName] }
}

function hasSingleStringLiteral(schema: OpenAPISchema | undefined): boolean {
  if (!isSchemaObject(schema)) return false
  if (typeof schema.const === "string") return true
  return schema.enum?.length === 1 && typeof schema.enum[0] === "string"
}

/**
 * Find discriminator branches in supported schema locations.
 *
 * Non-schema data and inline branches are ignored. Invalid referenced branch
 * refs throw `LoadError`; conflicts between valid injections are handled separately.
 */
export function discoverInjections(doc: OpenAPIDocument): Injection[] {
  const out: Injection[] = []
  mapDocumentSchemas(doc, (schema, location) => {
    collectDiscriminator(schema, location, out)
    return schema
  })
  return out
}

/** Select the composition branches an existing discriminator applies to. */
function discriminatorBranches(
  schema: OpenAPISchemaObject,
): ["oneOf" | "anyOf", OpenAPISchema[]] | null {
  if (Array.isArray(schema.oneOf)) return ["oneOf", schema.oneOf]
  if (Array.isArray(schema.anyOf)) return ["anyOf", schema.anyOf]
  return null
}

function collectDiscriminator(schema: OpenAPISchema, location: string, out: Injection[]): void {
  if (!isSchemaObject(schema)) return
  const disc = schema.discriminator
  if (!isObject(disc) || typeof disc.propertyName !== "string") return
  const selected = discriminatorBranches(schema)
  if (selected) collectFromDiscriminator(disc, selected[1], selected[0], location, out)
}

function collectFromDiscriminator(
  disc: Record<string, unknown>,
  branches: unknown[],
  containerKey: "oneOf" | "anyOf",
  location: string,
  out: Injection[],
): void {
  const propertyName = disc.propertyName as string
  const mapping =
    isObject(disc.mapping) && !Array.isArray(disc.mapping)
      ? (disc.mapping as Record<string, string>)
      : {}

  branches.forEach((branch, index) => {
    const branchLocation = appendPointer(location, containerKey, index)
    if (!isObject(branch)) return
    if (typeof branch.$ref !== "string") return
    const ref = branch.$ref
    const schemaName = schemaNameFromRef(ref, branchLocation)
    const value = findValueForBranch(ref, schemaName, mapping)
    out.push({ schemaName, propertyName, value, sourceLocation: branchLocation })
  })
}

function findValueForBranch(
  ref: string,
  schemaName: string,
  mapping: Record<string, string>,
): string {
  for (const [v, target] of Object.entries(mapping)) {
    if (target === ref || target === schemaName) return v
  }
  return schemaName
}

/** Group injections and reject conflicting values for the same property. */
export function reduceInjections(injections: Injection[]): SchemaInjections {
  const out: SchemaInjections = new Map()
  for (const inj of injections) {
    let perSchema = out.get(inj.schemaName)
    if (!perSchema) {
      perSchema = new Map()
      out.set(inj.schemaName, perSchema)
    }
    const existing = perSchema.get(inj.propertyName)
    if (existing && existing.value !== inj.value) {
      throw new LoadError(
        `Discriminator value conflict for "${inj.schemaName}.${inj.propertyName}": "${existing.value}" (at ${existing.sourceLocation}) vs "${inj.value}" (at ${inj.sourceLocation})`,
      )
    }
    perSchema.set(inj.propertyName, { value: inj.value, sourceLocation: inj.sourceLocation })
  }
  return out
}

/** Apply discriminator literals, rejecting missing targets and incompatible properties. */
export function applyInjections(
  doc: OpenAPIDocument,
  injections: SchemaInjections,
): OpenAPIDocument {
  if (injections.size === 0) return doc
  const schemas = doc.components?.schemas
  if (!schemas) return doc

  for (const name of injections.keys()) {
    if (!Object.hasOwn(schemas, name)) {
      throw new LoadError(
        `Discriminator branch references unknown schema "${name}" (at /components/schemas/${name})`,
      )
    }
  }

  const newSchemas: Record<string, OpenAPISchema> = {}
  for (const [name, schema] of Object.entries(schemas)) {
    const perSchema = injections.get(name)
    newSchemas[name] = perSchema ? injectInto(schema, perSchema, name) : schema
  }
  return { ...doc, components: { ...doc.components, schemas: newSchemas } }
}

function injectInto(
  schema: OpenAPISchema,
  perSchema: Map<string, ReducedInjection>,
  schemaName: string,
): OpenAPISchema {
  if (!isSchemaObject(schema)) {
    throw new LoadError(
      `Cannot inject discriminator into "${schemaName}": schema is boolean (at /components/schemas/${schemaName})`,
    )
  }
  if (schema.allOf) return injectIntoAllOf(schema, perSchema, schemaName)
  if (schema.type !== undefined && schema.type !== "object") {
    throw new LoadError(
      `Cannot inject discriminator into "${schemaName}": schema is not an object type (got "${String(schema.type)}") (at /components/schemas/${schemaName})`,
    )
  }

  const properties: Record<string, OpenAPISchema> = { ...schema.properties }
  const required = new Set<string>(schema.required ?? [])
  for (const [propertyName, { value }] of perSchema) {
    const existing = properties[propertyName]
    if (existing) validateExistingProperty(schemaName, propertyName, existing, value)
    properties[propertyName] = { const: value }
    required.add(propertyName)
  }
  return { ...schema, properties, required: [...required] }
}

function injectIntoAllOf(
  schema: OpenAPISchemaObject,
  perSchema: Map<string, ReducedInjection>,
  schemaName: string,
): OpenAPISchema {
  const allOf = [...(schema.allOf ?? [])]
  const targetIndex = allOf.findIndex((m) => canReceiveDiscriminator(m))
  if (targetIndex === -1) {
    allOf.push(createDiscriminatorMember(perSchema))
  } else {
    allOf[targetIndex] = injectInto(allOf[targetIndex], perSchema, schemaName)
  }
  return { ...schema, allOf }
}

function canReceiveDiscriminator(member: OpenAPISchema | undefined): boolean {
  if (!member || typeof member !== "object" || member.$ref || member.allOf) return false
  return member.type === undefined || member.type === "object"
}

function createDiscriminatorMember(perSchema: Map<string, ReducedInjection>): OpenAPISchema {
  const properties: Record<string, OpenAPISchema> = {}
  const required: string[] = []
  for (const [propertyName, { value }] of perSchema) {
    properties[propertyName] = { const: value }
    required.push(propertyName)
  }
  return { type: "object", properties, required }
}

function validateExistingProperty(
  schemaName: string,
  propertyName: string,
  existing: OpenAPISchema,
  value: string,
): void {
  const at = `/components/schemas/${schemaName}/properties/${propertyName}`
  if (!isSchemaObject(existing)) {
    throw new LoadError(
      `Discriminator conflict in schema "${schemaName}": "${propertyName}" is a boolean schema (at ${at})`,
    )
  }
  if ("const" in existing) {
    if (existing.const !== value) {
      throw new LoadError(
        `Discriminator conflict in schema "${schemaName}": "${propertyName}" is declared as const "${String(existing.const)}", but discriminator says "${value}" (at ${at})`,
      )
    }
    return
  }
  if (Array.isArray(existing.enum)) {
    if (!existing.enum.includes(value)) {
      const printed = existing.enum.map((e) => JSON.stringify(e)).join(", ")
      throw new LoadError(
        `Discriminator conflict in schema "${schemaName}": "${propertyName}" is declared as enum [${printed}], but discriminator says "${value}" (at ${at})`,
      )
    }
    return
  }
  if (existing.type !== undefined && existing.type !== "string") {
    throw new LoadError(
      `Discriminator conflict in schema "${schemaName}": "${propertyName}" is declared as type "${String(existing.type)}", but discriminator requires string literal "${value}" (at ${at})`,
    )
  }
}
