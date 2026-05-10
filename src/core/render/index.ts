import type { IR } from "../build/ir";
import { renderEndpointsInterface } from "./endpoint";
import type { RenderEntryOptions } from "./entry";
import { renderInfo } from "./info";
import { renderSchemas } from "./schema";
import { renderWebhooksInterface } from "./webhook";

export type RenderOptions = RenderEntryOptions;

export function render(ir: IR, options: RenderOptions = {}): string {
  const parts: string[] = [];
  parts.push(renderInfo(ir.info));
  if (ir.endpoints.length > 0) parts.push(renderEndpointsInterface(ir.endpoints, options));
  if (ir.webhooks.length > 0) parts.push(renderWebhooksInterface(ir.webhooks, options));
  if (ir.schemas.length > 0) parts.push(renderSchemas(ir.schemas));
  return `${parts.join("\n\n")}\n`;
}
