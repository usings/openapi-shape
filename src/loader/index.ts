import type { OpenAPIDocument } from "../types/openapi";
import { readSource } from "./source";
import { normalize } from "./normalize";
import { resolveRefs } from "./refs";
import { injectDiscriminators } from "./discriminator";

/**
 * Load a source and return an OpenAPI document ready for IR building.
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

// Internal loader stages, exported from this module for focused tests only.
// The package root exposes only `loadDocument` and `prepareDocument`.
export { readSource } from "./source";
export { normalize } from "./normalize";
export { resolveRefs } from "./refs";
export { injectDiscriminators } from "./discriminator";
