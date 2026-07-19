import { LoadError } from "./errors"
import type { OpenAPIDocument, OpenAPISchema } from "./openapi"
import { mapDocumentSchemas } from "./walk"

/**
 * Normalize OpenAPI version differences before the rest of the pipeline runs.
 * Missing versions are treated like 3.1 documents, which need no schema rewrite.
 */
export function normalize(raw: unknown): OpenAPIDocument {
  if (raw === null || typeof raw !== "object") {
    throw new LoadError("OpenAPI document must be an object")
  }
  const doc = raw as OpenAPIDocument
  const version = typeof doc.openapi === "string" ? doc.openapi : ""

  if (version === "" || /^3\.1\.\d+$/.test(version)) {
    return mapDocumentSchemas(doc, (s) => s)
  }
  if (/^3\.0\.\d+$/.test(version)) {
    return mapDocumentSchemas(doc, rewrite30Schema)
  }
  throw new LoadError(`Unsupported OpenAPI version: ${version}. Supported: 3.0.x, 3.1.x.`)
}

function rewrite30Schema(schema: OpenAPISchema): OpenAPISchema {
  if (typeof schema === "boolean") return schema
  if (!schema.nullable) return schema
  if (typeof schema.type !== "string") return schema
  const { nullable: _n, ...nonNullSchema } = schema
  // A type array would still require `null` to satisfy siblings such as `enum` and
  // `allOf`; a separate branch makes the entire 3.0 schema nullable instead.
  return { anyOf: [nonNullSchema, { type: "null" }] }
}
