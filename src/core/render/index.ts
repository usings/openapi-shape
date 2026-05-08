import type { IR } from "../build/ir";
import { renderHeader, type HeaderOption } from "./header";
import { renderEndpointsInterface } from "./endpoint";
import { renderWebhooksInterface } from "./webhook";
import { renderSchemas } from "./schema";
import type { RenderEntryOptions } from "./entry";

export interface RenderOptions extends RenderEntryOptions {
  /** File header. Defaults to a JSDoc banner derived from the spec's `info`; pass `false` to omit, or a function `(info) => string` to fully customize. */
  header?: HeaderOption;
}

export function render(ir: IR, options: RenderOptions = {}): string {
  const parts: string[] = [];
  const header = renderHeader(ir.info, options.header);
  if (header !== null) parts.push(header);
  if (ir.endpoints.length > 0) parts.push(renderEndpointsInterface(ir.endpoints, options));
  if (ir.webhooks.length > 0) parts.push(renderWebhooksInterface(ir.webhooks, options));
  if (ir.schemas.length > 0) parts.push(renderSchemas(ir.schemas));
  return parts.join("\n\n") + "\n";
}

export { renderHeader, renderEndpointsInterface, renderWebhooksInterface, renderSchemas };
