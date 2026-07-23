import type { WebhookOperation } from "../contract/model"
import { renderOperationEntry, renderOperationsInterface } from "./operation"
import type { DeclarationOptions } from "./options"

export function renderWebhooksInterface(
  webhooks: WebhookOperation[],
  options: DeclarationOptions = {},
): string {
  return renderOperationsInterface(
    "Webhooks",
    webhooks.map((e) => renderWebhookEntry(e, options)),
  )
}

function renderWebhookEntry(webhook: WebhookOperation, options: DeclarationOptions): string {
  return renderOperationEntry(webhook, { bodyKey: "payload", responseKey: "reply" }, options)
}
