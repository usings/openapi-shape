import type { EndpointModel } from "../build/ir";
import { indentContinuation } from "./format";
import { safeKey } from "../shared/naming";
import {
  type RenderEntryOptions,
  entryDocHeader,
  renderBody,
  renderErrors,
  renderParam,
  renderResponse,
} from "./entry";

export function renderWebhooksInterface(
  webhooks: EndpointModel[],
  options: RenderEntryOptions = {},
): string {
  const entries = webhooks.map((e) => renderWebhookEntry(e, options));
  return `export interface Webhooks {\n${entries.join("\n")}\n}`;
}

function renderWebhookEntry(webhook: EndpointModel, options: RenderEntryOptions): string {
  const docHeader = entryDocHeader(webhook);
  const lines: string[] = [];
  lines.push(`    query: ${indentContinuation(renderParam(webhook.query), "    ")}`);
  if (options.headers) {
    lines.push(`    headers: ${indentContinuation(renderParam(webhook.headers), "    ")}`);
  }
  lines.push(`    ${renderBody(webhook.body, "payload")}`);
  lines.push(`    reply: ${renderResponse(webhook.responses.success)}`);

  if (options.errors && webhook.responses.errors.length > 0) {
    lines.push(`    errors: ${renderErrors(webhook.responses.errors)}`);
  }

  return `${docHeader}  ${safeKey(webhook.key)}: {\n${lines.join("\n")}\n  }`;
}
