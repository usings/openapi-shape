import type {
  CallbackOperation,
  Contract,
  EndpointOperation,
  WebhookOperation,
} from "../contract/model"
import { renderCallbacksInterface } from "./callback"
import { renderEndpointsInterface } from "./endpoint"
import { renderInfo } from "./info"
import type { DeclarationOptions } from "./options"
import { renderSchemas } from "./schema"
import { renderWebhooksInterface } from "./webhook"

export type { DeclarationOptions } from "./options"

/** Render a complete TypeScript declaration module from the normalized contract IR. */
export function renderDeclarations(contract: Contract, options: DeclarationOptions = {}): string {
  const parts: string[] = []
  const endpoints: EndpointOperation[] = []
  const webhooks: WebhookOperation[] = []
  const callbacks: CallbackOperation[] = []
  for (const op of contract.operations) {
    if (op.kind === "endpoint") endpoints.push(op)
    else if (op.kind === "webhook") webhooks.push(op)
    else callbacks.push(op)
  }
  parts.push(renderInfo(contract.info))
  if (endpoints.length > 0) parts.push(renderEndpointsInterface(endpoints, options))
  if (webhooks.length > 0) parts.push(renderWebhooksInterface(webhooks, options))
  if (callbacks.length > 0) parts.push(renderCallbacksInterface(callbacks, options))
  if (contract.schemas.length > 0) parts.push(renderSchemas(contract.schemas, options))
  return `${parts.join("\n\n")}\n`
}
