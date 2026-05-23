import { buildContract } from "./build"
import type { Contract } from "./contract"
import { loadDocument, prepareDocument } from "./document"

/**
 * Read an OpenAPI source and build the normalized contract IR.
 *
 * The source is parsed as JSON, normalized, resolved, enriched with
 * discriminator literals, and then converted into contract schemas and
 * operations.
 */
export async function loadContract(source: string | URL): Promise<Contract> {
  return buildContract(await loadDocument(source))
}

/**
 * Build the normalized contract IR from an in-memory OpenAPI-like value.
 *
 * This runs the same preparation pipeline as `loadContract`, minus source I/O.
 */
export function prepareContract(raw: unknown): Contract {
  return buildContract(prepareDocument(raw))
}
