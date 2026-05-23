import type { Contract, EndpointOperation, WebhookOperation } from "../contract/contract"
import { renderEndpointsInterface } from "./endpoint"
import { renderInfo } from "./info"
import type { DeclarationOptions } from "./options"
import { renderSchemas } from "./schema"
import { renderWebhooksInterface } from "./webhook"

export type { DeclarationOptions } from "./options"

export function renderDeclarations(contract: Contract, options: DeclarationOptions = {}): string {
  const parts: string[] = []
  const endpoints = contract.operations.filter(
    (op): op is EndpointOperation => op.kind === "endpoint",
  )
  const webhooks = contract.operations.filter((op): op is WebhookOperation => op.kind === "webhook")
  parts.push(renderInfo(contract.info))
  if (endpoints.length > 0) parts.push(renderEndpointsInterface(endpoints, options))
  if (webhooks.length > 0) parts.push(renderWebhooksInterface(webhooks, options))
  if (contract.schemas.length > 0) parts.push(renderSchemas(contract.schemas, options))
  return `${parts.join("\n\n")}\n`
}
