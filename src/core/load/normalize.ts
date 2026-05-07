import type { OpenAPIDocument, OpenAPISchema } from "./openapi";
import { LoadError } from "../shared/errors";
import { mapDocumentSchemas } from "./walk";

/**
 * Normalize OpenAPI version differences before the rest of the pipeline runs.
 * Missing versions are treated like 3.1 documents, which need no schema rewrite.
 */
export function normalize(raw: unknown): OpenAPIDocument {
  if (raw === null || typeof raw !== "object") {
    throw new LoadError("OpenAPI document must be an object");
  }
  const doc = raw as OpenAPIDocument;
  const version = typeof doc.openapi === "string" ? doc.openapi : "";

  if (version === "" || /^3\.1\.\d+$/.test(version)) {
    return mapDocumentSchemas(doc, (s) => s);
  }
  if (/^3\.0\.\d+$/.test(version)) {
    return mapDocumentSchemas(doc, rewrite30Schema);
  }
  throw new LoadError(`Unsupported OpenAPI version: ${version}. Supported: 3.0.x, 3.1.x.`);
}

function rewrite30Schema(schema: OpenAPISchema): OpenAPISchema {
  if (!schema.nullable) return schema;
  if (typeof schema.type !== "string") return schema;
  const t = schema.type;
  if (t === "string" || t === "number" || t === "integer" || t === "boolean") {
    const { nullable: _n, ...rest } = schema;
    return { ...rest, type: [t, "null"] };
  }
  return schema;
}
