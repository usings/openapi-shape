import type {
  ContractPayload,
  ContractShape,
  ContractOperation,
  ErrorResponse,
  ContractFields,
} from "../contract/contract";
import { safeKey } from "../shared/naming";
import { indent, indentContinuation, jsdoc } from "./format";
import { renderTypeNode, shapeToTypeNode } from "./schema";
import type { RenderTypeNodeOptions } from "./schema";

const schemaRefOptions = { refPrefix: "Schemas." } as const;

export function entryDocHeader(entry: ContractOperation): string {
  return jsdoc(
    {
      summary: entry.summary,
      description: entry.description,
      deprecated: entry.deprecated,
    },
    "  ",
  );
}

export function renderParam(group: ContractFields, options: RenderTypeNodeOptions = {}): string {
  if (group.fields.length === 0) return "void";
  const hasDocs = group.fields.some((f) => f.docs?.description || f.docs?.deprecated);
  const renderOptions = { ...options, ...schemaRefOptions };
  const renderField = (f: { name: string; required: boolean; shape: ContractShape }) => {
    const opt = f.required ? "" : "?";
    return `${safeKey(f.name)}${opt}: ${renderTypeNode(shapeToTypeNode(f.shape, renderOptions), renderOptions)}`;
  };
  if (!hasDocs) return `{ ${group.fields.map(renderField).join("; ")} }`;
  const body = group.fields.map((f) => `${jsdoc(f.docs ?? {})}${renderField(f)}`).join("\n");
  return `{\n${indent(body)}\n}`;
}

export function renderBody(
  body: ContractPayload,
  key: string,
  options: RenderTypeNodeOptions = {},
): string {
  if (body.kind === "none") return `${key}: void`;
  const renderOptions = { ...options, ...schemaRefOptions };
  const t = indentContinuation(
    renderTypeNode(shapeToTypeNode(body.shape, renderOptions), renderOptions),
    "    ",
  );
  return body.required ? `${key}: ${t}` : `${key}?: ${t}`;
}

export function renderResponse(
  success: ContractShape | null,
  options: RenderTypeNodeOptions = {},
): string {
  if (!success) return "unknown";
  const renderOptions = { ...options, ...schemaRefOptions };
  return indentContinuation(
    renderTypeNode(shapeToTypeNode(success, renderOptions), renderOptions),
    "    ",
  );
}

export function renderErrors(errors: ErrorResponse[], options: RenderTypeNodeOptions = {}): string {
  const renderOptions = { ...options, ...schemaRefOptions };
  return `{ ${errors.map((e) => `"${e.status}": ${renderTypeNode(shapeToTypeNode(e.shape, renderOptions), renderOptions)}`).join("; ")} }`;
}
