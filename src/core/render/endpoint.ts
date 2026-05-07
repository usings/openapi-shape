import type { EndpointModel, ErrorResponse, ParamGroup, BodyModel, TypeNode } from "../build/ir";
import { renderTypeNode } from "./schema";
import { indent, indentContinuation, jsdoc } from "./format";
import { safeKey } from "../shared/naming";

export interface RenderEndpointsOptions {
  errors?: boolean;
}

export function renderEndpointsInterface(
  endpoints: EndpointModel[],
  options: RenderEndpointsOptions = {},
): string {
  const entries = endpoints.map((e) => renderEndpointEntry(e, options));
  return `export interface Endpoints {\n${entries.join("\n")}\n}`;
}

function renderEndpointEntry(endpoint: EndpointModel, options: RenderEndpointsOptions): string {
  const docHeader = jsdoc(
    {
      summary: endpoint.summary,
      description: endpoint.description,
      deprecated: endpoint.deprecated,
    },
    "  ",
  );

  const lines: string[] = [];
  lines.push(`    params: ${indentContinuation(renderParam(endpoint.params), "    ")}`);
  lines.push(`    query: ${indentContinuation(renderParam(endpoint.query), "    ")}`);
  lines.push(`    ${renderBody(endpoint.body)}`);
  lines.push(`    response: ${renderResponse(endpoint.responses.success)}`);

  if (options.errors && endpoint.responses.errors.length > 0) {
    lines.push(`    errors: ${renderErrors(endpoint.responses.errors)}`);
  }

  return `${docHeader}  ${safeKey(endpoint.key)}: {\n${lines.join("\n")}\n  }`;
}

function renderParam(group: ParamGroup): string {
  if (group.fields.length === 0) return "void";
  const hasDocs = group.fields.some((f) => f.docs?.description || f.docs?.deprecated);
  const renderField = (f: { name: string; required: boolean; type: TypeNode }) => {
    const opt = f.required ? "" : "?";
    return `${safeKey(f.name)}${opt}: ${renderTypeNode(f.type)}`;
  };
  if (!hasDocs) return `{ ${group.fields.map(renderField).join("; ")} }`;
  const body = group.fields.map((f) => `${jsdoc(f.docs ?? {})}${renderField(f)}`).join("\n");
  return `{\n${indent(body)}\n}`;
}

function renderBody(body: BodyModel): string {
  if (body.kind === "none") return "body: void";
  const t = indentContinuation(renderTypeNode(body.type), "    ");
  return body.required ? `body: ${t}` : `body?: ${t}`;
}

function renderResponse(success: TypeNode | null): string {
  if (!success) return "unknown";
  return indentContinuation(renderTypeNode(success), "    ");
}

function renderErrors(errors: ErrorResponse[]): string {
  return `{ ${errors.map((e) => `"${e.status}": ${renderTypeNode(e.type)}`).join("; ")} }`;
}
