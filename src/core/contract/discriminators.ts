import { isObject, isObjectAdditional } from "../shared/object"
import { LoadError } from "./errors"
import type { OpenAPIDocument, OpenAPISchema } from "./openapi"
import { mapDocument } from "./walk"

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
  return applyInjections(doc, reduceInjections(discoverInjections(doc)))
}

/**
 * Find discriminator branches in supported schema locations.
 *
 * Non-schema data is ignored. Structurally invalid branches throw `LoadError`;
 * conflicts between otherwise valid injections are handled separately.
 */
export function discoverInjections(doc: OpenAPIDocument): Injection[] {
  const out: Injection[] = []
  mapDocument(doc, {
    schema: (schema, location) => {
      walkSchema(schema, location, out)
      return schema
    },
  })
  return out
}

function walkSchema(schema: OpenAPISchema, location: string, out: Injection[]): void {
  if (!isObject(schema)) return

  const disc = schema.discriminator
  if (isObject(disc) && typeof disc.propertyName === "string") {
    if (Array.isArray(schema.oneOf)) {
      collectFromDiscriminator(disc, schema.oneOf, "oneOf", location, out)
    } else if (Array.isArray(schema.anyOf)) {
      collectFromDiscriminator(disc, schema.anyOf, "anyOf", location, out)
    }
  }

  for (const key of ["properties", "patternProperties"] as const) {
    const record = schema[key]
    if (!record) continue
    for (const [name, child] of Object.entries(record)) {
      walkSchema(child, `${location}/${key}/${name}`, out)
    }
  }
  if (typeof schema.items === "object" && schema.items !== null) {
    walkSchema(schema.items, `${location}/items`, out)
  }
  if (Array.isArray(schema.prefixItems)) {
    schema.prefixItems.forEach((child, index) => {
      walkSchema(child, `${location}/prefixItems/${index}`, out)
    })
  }
  if (isObjectAdditional<OpenAPISchema>(schema.additionalProperties)) {
    walkSchema(schema.additionalProperties, `${location}/additionalProperties`, out)
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[key]
    if (Array.isArray(branches)) {
      branches.forEach((child, index) => {
        walkSchema(child, `${location}/${key}/${index}`, out)
      })
    }
  }
}

function collectFromDiscriminator(
  disc: Record<string, unknown>,
  branches: unknown[],
  containerKey: "oneOf" | "anyOf",
  location: string,
  out: Injection[],
): void {
  const propertyName = disc.propertyName as string
  const mapping = isObject(disc.mapping) ? (disc.mapping as Record<string, string>) : {}

  branches.forEach((branch, index) => {
    const branchLocation = `${location}/${containerKey}[${index}]`
    if (!isObject(branch) || typeof branch.$ref !== "string") {
      throw new LoadError(
        `discriminator branch must be $ref; got inline schema (at ${branchLocation})`,
      )
    }
    const ref = branch.$ref
    if (!ref.startsWith("#/components/schemas/")) {
      throw new LoadError(
        `discriminator branch $ref must point to components.schemas; got ${ref} (at ${branchLocation})`,
      )
    }
    const schemaName = ref.slice("#/components/schemas/".length)
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
    if (!(name in schemas)) {
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
  schema: OpenAPISchema,
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
