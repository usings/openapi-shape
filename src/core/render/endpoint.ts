import type { EndpointModel } from "../build/ir";
import { safeKey } from "../shared/naming";
import { entryDocHeader, renderBody, renderErrors, renderParam, renderResponse } from "./entry";
import type { RenderEntryOptions } from "./entry";
import { indentContinuation } from "./format";

export function renderEndpointsInterface(
  endpoints: EndpointModel[],
  options: RenderEntryOptions = {},
): string {
  const entries = endpoints.map((e) => renderEndpointEntry(e, options));
  return `export interface Endpoints {\n${entries.join("\n")}\n}`;
}

function renderEndpointEntry(endpoint: EndpointModel, options: RenderEntryOptions): string {
  const docHeader = entryDocHeader(endpoint);
  const lines: string[] = [];
  lines.push(`    params: ${indentContinuation(renderParam(endpoint.params), "    ")}`);
  lines.push(`    query: ${indentContinuation(renderParam(endpoint.query), "    ")}`);
  if (options.headers) {
    lines.push(`    headers: ${indentContinuation(renderParam(endpoint.headers), "    ")}`);
  }
  lines.push(`    ${renderBody(endpoint.body, "body")}`);
  lines.push(`    response: ${renderResponse(endpoint.responses.success)}`);

  if (options.errors && endpoint.responses.errors.length > 0) {
    lines.push(`    errors: ${renderErrors(endpoint.responses.errors)}`);
  }

  return `${docHeader}  ${safeKey(endpoint.key)}: {\n${lines.join("\n")}\n  }`;
}
