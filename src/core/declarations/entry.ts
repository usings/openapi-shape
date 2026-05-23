import type {
  ContractPayload,
  ContractShape,
  ContractOperation,
  ContractOutcome,
  ContractField,
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

export function renderParam(fields: ContractField[], options: RenderTypeNodeOptions = {}): string {
  if (fields.length === 0) return "void";
  const hasDocs = fields.some((f) => f.docs?.description || f.docs?.deprecated);
  const renderOptions = { ...options, ...schemaRefOptions };
  const renderField = (f: { name: string; required: boolean; shape: ContractShape }) => {
    const opt = f.required ? "" : "?";
    return `${safeKey(f.name)}${opt}: ${renderTypeNode(shapeToTypeNode(f.shape, renderOptions), renderOptions)}`;
  };
  if (!hasDocs) return `{ ${fields.map((f) => renderField(f)).join("; ")} }`;
  const body = fields.map((f) => `${jsdoc(f.docs ?? {})}${renderField(f)}`).join("\n");
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

export function renderResponseMap(
  responses: ContractOutcome[],
  options: RenderTypeNodeOptions = {},
): string {
  if (responses.length === 0) return "unknown";
  const renderOptions = { ...options, ...schemaRefOptions };
  const entries = responses.map(
    (r) =>
      `"${r.status}": ${renderTypeNode(shapeToTypeNode(r.shape, renderOptions), renderOptions)}`,
  );
  return `{ ${entries.join("; ")} }`;
}
