import type { OpenAPIDocument } from "../openapi/types"
import { safeIdentifier } from "../shared/naming"
import { escapePointerSegment } from "../shared/pointer"
import { docBlock } from "./doc"
import { BuildError } from "./errors"
import type { ContractSchema, ContractField } from "./model"
import { buildContractType, objectIndexType } from "./schema-type"

/**
 * Build named contract schemas from `components.schemas` in declaration order.
 *
 * A schema becomes an interface only when it explicitly declares `type: object`,
 * has `properties`, and has no composition keywords; all other schemas become
 * aliases. Names are sanitized for TypeScript and collisions after sanitization
 * throw `BuildError`.
 */
export function buildSchemas(doc: OpenAPIDocument): ContractSchema[] {
  const raw = doc.components?.schemas
  if (!raw) return []

  const sanitizedToOriginal = new Map<string, string>()
  for (const name of Object.keys(raw)) {
    const sanitized = safeIdentifier(name)
    const prior = sanitizedToOriginal.get(sanitized)
    if (prior !== undefined && prior !== name) {
      throw new BuildError(
        `Schema name collision after sanitization at /components/schemas: "${prior}" and "${name}" both → "${sanitized}"`,
      )
    }
    sanitizedToOriginal.set(sanitized, name)
  }

  const result: ContractSchema[] = []
  for (const [originalName, schema] of Object.entries(raw)) {
    const name = safeIdentifier(originalName)
    // Schemas with composition remain aliases so composition and sibling
    // constraints can be represented without loss.
    const hasComposition =
      typeof schema === "object" ? (schema.allOf ?? schema.oneOf ?? schema.anyOf) : undefined
    if (
      typeof schema === "object" &&
      schema.type === "object" &&
      schema.properties &&
      !hasComposition
    ) {
      const required = new Set<string>(schema.required ?? [])
      const fields: ContractField[] = Object.entries(schema.properties).map(([fname, fschema]) => ({
        name: fname,
        required: required.has(fname),
        type: buildContractType(fschema),
        docs: docBlock(fschema),
      }))
      const index = objectIndexType(schema)
      result.push({
        name,
        originalName,
        kind: "interface",
        fields,
        ...(index !== null && { index }),
        docs: docBlock(schema),
        source: { location: `/components/schemas/${escapePointerSegment(originalName)}` },
      })
    } else {
      result.push({
        name,
        originalName,
        kind: "alias",
        type: buildContractType(schema),
        docs: docBlock(schema),
        source: { location: `/components/schemas/${escapePointerSegment(originalName)}` },
      })
    }
  }
  return result
}
