import type { Contract } from "./contract"
import type { OpenAPIDocument } from "./openapi"
import { buildOperations } from "./operations"
import { buildSchemas } from "./schemas"

export function buildContract(doc: OpenAPIDocument): Contract {
  return {
    info: buildInfo(doc),
    schemas: buildSchemas(doc),
    operations: buildOperations(doc),
  }
}

function buildInfo(doc: OpenAPIDocument): Contract["info"] {
  const info = doc.info ?? {}
  const out: Contract["info"] = {}
  if (typeof info.title === "string" && info.title.trim()) out.title = info.title.trim()
  if (typeof info.version === "string" && info.version.trim()) out.version = info.version.trim()
  if (typeof info.description === "string" && info.description.trim())
    out.description = info.description.trim()
  return out
}
