import { BuildContext } from "./build-context"
import { Diagnostics } from "./diagnostics"
import type { DocumentSet } from "./documents"
import type { GenerationControl } from "./generation-control"
import { assignInputVariants } from "./input-variants"
import type { ApiModel, Info } from "./model"
import { normalizeModel } from "./normalize-model"
import { isRecord } from "./object"
import { buildOperations } from "./operations"
import { discoverReferences } from "./reference-discovery"
import { supportedDialect } from "./schema-rules"
import { SchemaBuilder } from "./schemas"

/** Load the reachable reference graph, then compile against its final document identities. */
export async function buildModel(
  documents: DocumentSet,
  control: GenerationControl,
): Promise<{ model: ApiModel; diagnostics: Diagnostics }> {
  await control.checkpoint()
  const discovered = await discoverReferences(documents, control)
  documents.finishDiscovery()
  const diagnostics = new Diagnostics()
  if (discovered.exhausted) {
    diagnostics.error("unresolved-ref", "References nest too deeply across documents", "#")
  }
  const model = await buildResolvedModel(
    new BuildContext(documents, diagnostics, control),
    discovered.repeated,
  )
  return { model, diagnostics }
}

async function buildResolvedModel(context: BuildContext, repeated: Set<string>): Promise<ApiModel> {
  const root = context.documents.root(context.documents.entry)
  const entry = isRecord(root.value) ? root.value : {}
  if (typeof entry.jsonSchemaDialect === "string" && !supportedDialect(entry.jsonSchemaDialect))
    context.error(
      "unsupported-version",
      `Unsupported JSON Schema dialect "${entry.jsonSchemaDialect}"`,
      root,
      "jsonSchemaDialect",
    )
  const schemas = new SchemaBuilder(context, repeated)
  schemas.declareComponents()
  await schemas.buildDeclarations()
  const operations = await buildOperations(context, schemas)
  // The schemas operations reference, named while building them.
  await schemas.buildDeclarations()

  await normalizeModel(schemas.declarations, operations, context)
  const model = { info: readInfo(entry), ...operations, declarations: schemas.declarations }
  assignInputVariants(model, context.diagnostics)
  return model
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
