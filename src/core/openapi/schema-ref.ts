import { decodePointerSegment } from "../shared/pointer"
import { LoadError } from "./errors"
import type { OpenAPIDocument, OpenAPISchema } from "./types"
import { isSchemaObject } from "./types"
import { mapDocumentSchemas } from "./walk"

const SCHEMA_REF_PREFIX = "#/components/schemas/"

/**
 * Decode the component name from a local `#/components/schemas/<name>` reference.
 *
 * The reference must identify exactly one component schema. URI encoding and
 * JSON Pointer escaping are decoded; external and nested references throw `LoadError`.
 */
export function schemaNameFromRef(ref: string, location?: string): string {
  const suffix = location ? ` (at ${location})` : ""
  if (!ref.startsWith(SCHEMA_REF_PREFIX)) {
    throw new LoadError(`Schema $ref must point to components.schemas; got ${ref}${suffix}`)
  }

  const encodedName = ref.slice(SCHEMA_REF_PREFIX.length)
  if (encodedName === "" || encodedName.includes("/")) {
    throw new LoadError(`Schema $ref must identify one component schema; got ${ref}${suffix}`)
  }

  try {
    return decodePointerSegment(decodeURIComponent(encodedName))
  } catch {
    throw new LoadError(`Schema $ref contains invalid URI encoding; got ${ref}${suffix}`)
  }
}

/** Validate that every schema reference is local and targets an existing component schema. */
export function validateSchemaRefs(doc: OpenAPIDocument): OpenAPIDocument {
  const schemas = doc.components?.schemas ?? {}
  return mapDocumentSchemas(doc, (schema: OpenAPISchema, location) => {
    if (!isSchemaObject(schema) || !schema.$ref) return schema
    const name = schemaNameFromRef(schema.$ref, location)
    if (!Object.hasOwn(schemas, name)) {
      throw new LoadError(`Schema $ref target not found: ${schema.$ref} (at ${location})`)
    }
    return schema
  })
}
