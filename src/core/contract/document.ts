import { injectDiscriminators } from "./discriminators";
import { normalize } from "./normalize";
import type { OpenAPIDocument } from "./openapi";
import { resolveRefs } from "./refs";
import { readSource } from "./source";

/**
 * Load a source and return an OpenAPI document ready for Contract building.
 */
export async function loadDocument(source: string | URL): Promise<OpenAPIDocument> {
  return prepareDocument(await readSource(source));
}

/**
 * Prepare an in-memory OpenAPI value. The pipeline is idempotent, so callers may
 * pass documents that have already been prepared.
 */
export function prepareDocument(raw: unknown): OpenAPIDocument {
  return injectDiscriminators(resolveRefs(normalize(raw)));
}
