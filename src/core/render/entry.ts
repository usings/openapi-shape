import type { BodyModel, EndpointModel, ErrorResponse, ParamGroup, TypeNode } from "../build/ir";
import { safeKey } from "../shared/naming";
import { indent, indentContinuation, jsdoc } from "./format";
import { renderTypeNode } from "./schema";

export interface RenderEntryOptions {
  /** Emit an `errors` field per entry, keyed by status code. For endpoints these are received error responses; for webhooks they are error replies the handler returns. */
  errors?: boolean;
  /** Emit a typed `headers` field per entry from `in: header` parameters. For endpoints these are headers the client sends; for webhooks they are headers the third party sends. */
  headers?: boolean;
}

export function entryDocHeader(entry: EndpointModel): string {
  return jsdoc(
    {
      summary: entry.summary,
      description: entry.description,
      deprecated: entry.deprecated,
    },
    "  ",
  );
}

export function renderParam(group: ParamGroup): string {
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

export function renderBody(body: BodyModel, key: string): string {
  if (body.kind === "none") return `${key}: void`;
  const t = indentContinuation(renderTypeNode(body.type), "    ");
  return body.required ? `${key}: ${t}` : `${key}?: ${t}`;
}

export function renderResponse(success: TypeNode | null): string {
  if (!success) return "unknown";
  return indentContinuation(renderTypeNode(success), "    ");
}

export function renderErrors(errors: ErrorResponse[]): string {
  return `{ ${errors.map((e) => `"${e.status}": ${renderTypeNode(e.type)}`).join("; ")} }`;
}
