import type { WebhookOperation } from "../contract/contract";
import { safeKey } from "../shared/naming";
import { entryDocHeader, renderBody, renderErrors, renderParam, renderResponse } from "./entry";
import { indentContinuation } from "./format";
import type { DeclarationOptions } from "./options";

export function renderWebhooksInterface(
  webhooks: WebhookOperation[],
  options: DeclarationOptions = {},
): string {
  const entries = webhooks.map((e) => renderWebhookEntry(e, options));
  return `export interface Webhooks {\n${entries.join("\n")}\n}`;
}

function renderWebhookEntry(webhook: WebhookOperation, options: DeclarationOptions): string {
  const docHeader = entryDocHeader(webhook);
  const lines: string[] = [];
  lines.push(`    query: ${indentContinuation(renderParam(webhook.query, options), "    ")}`);
  if (options.headers) {
    lines.push(`    headers: ${indentContinuation(renderParam(webhook.headers, options), "    ")}`);
  }
  lines.push(`    ${renderBody(webhook.body, "payload", options)}`);
  lines.push(`    reply: ${renderResponse(webhook.responses.success, options)}`);

  if (options.errors && webhook.responses.errors.length > 0) {
    lines.push(`    errors: ${renderErrors(webhook.responses.errors, options)}`);
  }

  return `${docHeader}  ${safeKey(webhook.key)}: {\n${lines.join("\n")}\n  }`;
}
