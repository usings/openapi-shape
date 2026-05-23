import type { EndpointOperation } from "../contract/contract"
import { safeKey } from "../shared/naming"
import { entryDocHeader, renderBody, renderParam, renderResponseMap } from "./entry"
import { indentContinuation } from "./format"
import type { DeclarationOptions } from "./options"

export function renderEndpointsInterface(
  endpoints: EndpointOperation[],
  options: DeclarationOptions = {},
): string {
  const entries = endpoints.map((e) => renderEndpointEntry(e, options))
  return `export interface Endpoints {\n${entries.join("\n")}\n}`
}

function renderEndpointEntry(endpoint: EndpointOperation, options: DeclarationOptions): string {
  const docHeader = entryDocHeader(endpoint)
  const lines: string[] = []
  lines.push(`    params: ${indentContinuation(renderParam(endpoint.params, options), "    ")}`)
  lines.push(`    query: ${indentContinuation(renderParam(endpoint.query, options), "    ")}`)
  if (options.headers) {
    lines.push(`    headers: ${indentContinuation(renderParam(endpoint.headers, options), "    ")}`)
  }
  lines.push(`    ${renderBody(endpoint.body, "body", options)}`)
  lines.push(
    `    response: ${indentContinuation(renderResponseMap(endpoint.responses, options), "    ")}`,
  )
  return `${docHeader}  ${safeKey(endpoint.key)}: {\n${lines.join("\n")}\n  }`
}
