// src/loader/index.ts
import type { OpenAPIDocument } from "../types/openapi";
import { readSource } from "./source";
import { normalize } from "./normalize";
import { resolveRefs } from "./refs";
import { injectDiscriminators } from "./discriminator";

/**
 * Read + parse + normalize + resolveRefs + injectDiscriminators.
 * Output is ready for buildIR().
 */
export async function loadDocument(source: string | URL): Promise<OpenAPIDocument> {
  return prepareDocument(await readSource(source));
}

/**
 * Synchronous prep pipeline for in-memory inputs.
 * Idempotent; safe to call on already-prepared documents.
 */
export function prepareDocument(raw: unknown): OpenAPIDocument {
  return injectDiscriminators(resolveRefs(normalize(raw)));
}

// Intra-package seams: used by src/loader/index.ts and tests only.
// NOT re-exported from src/index.ts — the package's public Loader interface
// is just `loadDocument` and `prepareDocument`. `normalize` / `resolveRefs` /
// `injectDiscriminators` are internal implementation details and may be
// rearranged or merged in future versions without notice.
export { readSource } from "./source";
export { normalize } from "./normalize";
export { resolveRefs } from "./refs";
export { injectDiscriminators } from "./discriminator";
