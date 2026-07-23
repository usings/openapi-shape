import type { EndpointOperation } from "../contract/model"
import { renderOperationEntry, renderOperationsInterface } from "./operation"
import type { DeclarationOptions } from "./options"

export function renderEndpointsInterface(
  endpoints: EndpointOperation[],
  options: DeclarationOptions = {},
): string {
  return renderOperationsInterface(
    "Endpoints",
    endpoints.map((e) => renderEndpointEntry(e, options)),
  )
}

function renderEndpointEntry(endpoint: EndpointOperation, options: DeclarationOptions): string {
  return renderOperationEntry(
    endpoint,
    { params: endpoint.params, bodyKey: "body", responseKey: "response" },
    options,
  )
}
