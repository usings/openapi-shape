import type { EndpointOperation } from "../contract/contract"
import { renderOperationEntry } from "./operation"
import type { DeclarationOptions } from "./options"

export function renderEndpointsInterface(
  endpoints: EndpointOperation[],
  options: DeclarationOptions = {},
): string {
  const entries = endpoints.map((e) => renderEndpointEntry(e, options))
  return `export interface Endpoints {\n${entries.join("\n")}\n}`
}

function renderEndpointEntry(endpoint: EndpointOperation, options: DeclarationOptions): string {
  return renderOperationEntry(
    endpoint,
    { params: endpoint.params, bodyKey: "body", responseKey: "response" },
    options,
  )
}
