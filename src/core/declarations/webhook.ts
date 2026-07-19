import type { WebhookOperation } from "../contract/contract"
import { renderOperationEntry } from "./operation"
import type { DeclarationOptions } from "./options"

export function renderWebhooksInterface(
  webhooks: WebhookOperation[],
  options: DeclarationOptions = {},
): string {
  const entries = webhooks.map((e) => renderWebhookEntry(e, options))
  return `export interface Webhooks {\n${entries.join("\n")}\n}`
}

function renderWebhookEntry(webhook: WebhookOperation, options: DeclarationOptions): string {
  return renderOperationEntry(webhook, { bodyKey: "payload", responseKey: "reply" }, options)
}
