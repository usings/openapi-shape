import type { IR } from "../build/ir";
import { renderHeader, type HeaderOption } from "./header";
import { renderEndpointsInterface } from "./endpoint";
import { renderSchemas } from "./schema";

export interface RenderOptions {
  header?: HeaderOption;
  errors?: boolean;
}

export function render(ir: IR, options: RenderOptions = {}): string {
  const parts: string[] = [];
  const header = renderHeader(ir.info, options.header);
  if (header !== null) parts.push(header);
  if (ir.endpoints.length > 0) parts.push(renderEndpointsInterface(ir.endpoints, options));
  if (ir.schemas.length > 0) parts.push(renderSchemas(ir.schemas));
  return parts.join("\n\n") + "\n";
}

export { renderHeader, renderEndpointsInterface, renderSchemas };
