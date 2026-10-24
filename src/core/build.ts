import { BuildContext } from "./build-context"
import { Diagnostics } from "./diagnostics"
import type { DocumentSet } from "./documents"
import type { Info, Model } from "./model"
import { normalizeModel } from "./normalize-model"
import { isRecord } from "./object"
import { buildOperations } from "./operations"
import { discoverReferences } from "./reference-discovery"
import { SchemaBuilder } from "./schemas"

/** Load the reachable reference graph, then compile against its final document identities. */
export async function buildModel(
  documents: DocumentSet,
): Promise<{ model: Model; diagnostics: Diagnostics }> {
  await documents.reader.checkpoint()
  const discovered = await discoverReferences(documents)
  documents.finishDiscovery()
  const diagnostics = new Diagnostics()
  if (discovered.exhausted) {
    diagnostics.error("unresolved-ref", "References nest too deeply across documents", "#")
  }
  const model = await buildResolvedModel(
    new BuildContext(documents, diagnostics),
    discovered.repeated,
  )
  return { model, diagnostics }
}

async function buildResolvedModel(context: BuildContext, repeated: Set<string>): Promise<Model> {
  const root = context.documents.root(context.documents.entry)
  const entry = isRecord(root.value) ? root.value : {}
  const schemas = new SchemaBuilder(context, repeated)
  schemas.declareComponents()
  await schemas.buildDeclarations()
  const operations = await buildOperations(context, schemas)
  // The schemas operations reference, named while building them.
  await schemas.buildDeclarations()

  await normalizeModel(schemas, operations)
  return { info: readInfo(entry), ...operations, declarations: schemas.declarations }
}

function readInfo(entry: Record<string, unknown>): Info {
  const servers = Array.isArray(entry.servers) ? entry.servers : []
  const info: Info = {
    openapi: String(entry.openapi),
    servers: servers.flatMap((s: unknown) =>
      isRecord(s) && typeof s.url === "string" ? [s.url] : [],
    ),
  }
  const source = isRecord(entry.info) ? entry.info : {}
  for (const key of ["title", "version", "description"] as const) {
    const value = source[key]
    if (typeof value === "string" && value.trim() !== "") info[key] = value.trim()
  }
  return info
}
