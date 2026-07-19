import type { OpenAPISchema, MediaType, Response } from "../openapi/types"
import { appendPointer } from "../shared/pointer"
import type { ContractType, ContractOutcome } from "./model"
import { buildContractType } from "./schema-type"

/**
 * Convert declared responses to contract outcomes while preserving response-key order.
 *
 * For each response, content is selected by category rather than raw declaration
 * order: JSON-family entries with schemas first, then binary media/schema entries,
 * `text/*`, other entries with schemas, and finally the first untyped entry as
 * binary. A response without usable content becomes `void`.
 */
export function buildResponses(
  responses: Record<string, Response>,
  location: string,
): ContractOutcome[] {
  const out: ContractOutcome[] = []
  for (const [status, response] of Object.entries(responses)) {
    const { type, contentType } = pickResponseType(response)
    out.push({
      status,
      type,
      ...(contentType !== undefined ? { contentType } : {}),
      source: { location: appendPointer(location, status) },
    })
  }
  return out
}

/** Return whether a media type has a `json` or `+json` subtype, ignoring parameters. */
export function isJsonContentType(ct: string): boolean {
  const essence = ct.split(";", 1)[0].trim().toLowerCase()
  const slash = essence.indexOf("/")
  if (slash === -1) return false
  const subtype = essence.slice(slash + 1)
  return subtype === "json" || subtype.endsWith("+json")
}

function pickResponseType(response: Response | undefined): {
  type: ContractType
  contentType?: string
} {
  if (!response?.content) return { type: { kind: "void" } }
  return extractResponseType(response.content) ?? { type: { kind: "void" } }
}

function extractResponseType(content: Record<string, MediaType>): {
  type: ContractType
  contentType?: string
} | null {
  for (const ct of Object.keys(content)) {
    if (isJsonContentType(ct) && content[ct].schema !== undefined) {
      return { type: buildContractType(content[ct].schema), contentType: ct }
    }
  }
  for (const ct of Object.keys(content)) {
    const schema = content[ct].schema
    if (isBinaryContentType(ct) || isBinarySchema(schema)) {
      if (schema === false) return { type: buildContractType(schema), contentType: ct }
      return { type: { kind: "binary" }, contentType: ct }
    }
  }
  for (const ct of Object.keys(content)) {
    if (ct.toLowerCase().startsWith("text/")) {
      const schema = content[ct].schema
      if (schema === false) return { type: buildContractType(schema), contentType: ct }
      return { type: { kind: "scalar", name: "string" }, contentType: ct }
    }
  }
  for (const ct of Object.keys(content)) {
    if (content[ct].schema !== undefined) {
      return { type: buildContractType(content[ct].schema), contentType: ct }
    }
  }
  const firstContentType = Object.keys(content)[0]
  if (firstContentType) return { type: { kind: "binary" }, contentType: firstContentType }
  return null
}

function isBinaryContentType(ct: string): boolean {
  const c = ct.toLowerCase()
  return (
    c === "application/octet-stream" ||
    c === "application/pdf" ||
    c === "application/zip" ||
    c.startsWith("image/") ||
    c.startsWith("audio/") ||
    c.startsWith("video/")
  )
}

function isBinarySchema(s: OpenAPISchema | undefined): boolean {
  return typeof s === "object" && (s.format === "binary" || s.format === "byte")
}
