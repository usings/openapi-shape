import { LoadError } from "./errors"
import type { OpenAPIDocument, OpenAPISchema } from "./types"
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

  // Swagger 2.0 documents have no `openapi` field and would otherwise be
  // silently accepted as 3.1 documents. Unquoted YAML parses `swagger: 2.0`
  // as a number, so any defined value counts as a Swagger declaration.
  const swagger = (raw as { swagger?: unknown }).swagger
  if (version === "" && swagger !== undefined) {
    throw new LoadError(
      `Unsupported Swagger version: ${String(swagger)}. Supported: OpenAPI 3.0.x, 3.1.x.`,
    )
  }

  // 3.1 documents need no schema rewrite; skip the traversal entirely.
  if (version === "" || /^3\.1\.\d+$/.test(version)) {
    return doc
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
