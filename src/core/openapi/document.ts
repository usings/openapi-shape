import { injectDiscriminators } from "./discriminators"
import { normalize } from "./normalize"
import { resolveRefs } from "./refs"
import { validateSchemaRefs } from "./schema-ref"
import { readSource } from "./source"
import type { OpenAPIDocument } from "./types"

/** Read an OpenAPI source, normalize it, resolve supported refs, and validate schemas. */
export async function loadDocument(source: string | URL): Promise<OpenAPIDocument> {
  return prepareDocument(await readSource(source))
}

/**
 * Prepare an in-memory OpenAPI value. The idempotent pipeline normalizes version
 * differences, resolves supported non-schema component refs, validates schema
 * refs, and materializes discriminator literals.
 */
export function prepareDocument(raw: unknown): OpenAPIDocument {
  return injectDiscriminators(validateSchemaRefs(resolveRefs(normalize(raw))))
}
