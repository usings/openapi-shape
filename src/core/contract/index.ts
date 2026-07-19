import { buildContract } from "./build"
import type { Contract } from "./contract"
import { loadDocument, prepareDocument } from "./document"

/**
 * Read an OpenAPI source and build the normalized contract IR.
 */
export async function loadContract(source: string | URL): Promise<Contract> {
  return buildContract(await loadDocument(source))
}

/**
 * Build the normalized contract IR from an in-memory OpenAPI-like value using
 * the same preparation pipeline as `loadContract`.
 */
export function prepareContract(raw: unknown): Contract {
  return buildContract(prepareDocument(raw))
}
