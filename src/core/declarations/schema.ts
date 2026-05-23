import type { ContractShape, ContractSchema, ContractField } from "../contract/contract";
import { safeKey } from "../shared/naming";
import { indent, jsdoc } from "./format";
import type { DeclarationOptions } from "./options";
import type { TypeNode, TypeField } from "./type-node";
import { schemaToTypeNode } from "./type-node";

/** Options used while rendering declaration-layer TypeNodes. */
export interface RenderTypeNodeOptions {
  /** Prefix to add to schema references, for example `Schemas.`. */
  refPrefix?: string;
  /** Custom OpenAPI `format` to TypeScript type-expression mappings. */
  formats?: DeclarationOptions["formats"];
}

/** Render a TypeNode into TypeScript source. */
export function renderTypeNode(node: TypeNode, options: RenderTypeNodeOptions = {}): string {
  switch (node.kind) {
    case "primitive":
      return node.name;
    case "literal":
      return literalToTs(node.value);
    case "ref":
      return `${options.refPrefix ?? ""}${node.name}`;
    case "raw":
      return node.text;
    case "array": {
      const inner = renderTypeNode(node.items, options);
      return needsParens(node.items) ? `(${inner})[]` : `${inner}[]`;
    }
    case "tuple": {
      const head = node.items.map((i) => renderTypeNode(i, options)).join(", ");
      if (!node.rest) return `[${head}]`;
      const rest = renderTypeNode(node.rest, options);
      const restRendered = needsParens(node.rest) ? `(${rest})[]` : `${rest}[]`;
      return head ? `[${head}, ...${restRendered}]` : `[...${restRendered}]`;
    }
    case "record":
      return `Record<string, ${renderTypeNode(node.values, options)}>`;
    case "object":
      return renderObject(node.fields, node.index, options);
    case "union":
      return node.members.map((m) => wrapForUnion(m, options)).join(" | ");
    case "intersection":
      return node.members.map((m) => wrapForIntersection(m, options)).join(" & ");
  }
}

function literalToTs(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function needsParens(node: TypeNode): boolean {
  return node.kind === "union" || node.kind === "intersection";
}

function wrapForUnion(node: TypeNode, options: RenderTypeNodeOptions): string {
  const r = renderTypeNode(node, options);
  if (node.kind === "intersection") return `(${r})`;
  return r;
}

function wrapForIntersection(node: TypeNode, options: RenderTypeNodeOptions): string {
  const r = renderTypeNode(node, options);
  if (node.kind === "union") return `(${r})`;
  return r;
}

function renderObject(
  fields: TypeField[],
  index: TypeNode | null,
  options: RenderTypeNodeOptions,
): string {
  const lines: string[] = [];
  for (const f of fields) {
    const docHeader = f.docs ? jsdoc(f.docs) : "";
    const opt = f.required ? "" : "?";
    lines.push(`${docHeader}${safeKey(f.name)}${opt}: ${renderTypeNode(f.type, options)}`);
  }
  if (index) lines.push(`[key: string]: ${renderTypeNode(index, options)}`);
  if (lines.length === 0) return "{}";
  return `{\n${indent(lines.join("\n"))}\n}`;
}

/** Convert a contract shape into the declaration-layer TypeNode IR. */
export function shapeToTypeNode(
  shape: ContractShape,
  options: RenderTypeNodeOptions = {},
): TypeNode {
  if (shape.kind === "primitive") return { kind: "primitive", name: shape.name };
  return schemaToTypeNode(shape.schema, options);
}

/** Render contract schemas into the generated `Schemas` namespace. */
export function renderSchemas(
  schemas: ContractSchema[],
  options: RenderTypeNodeOptions = {},
): string {
  const aliases: string[] = [];
  const interfaces: string[] = [];
  for (const s of schemas) {
    const docHeader = s.docs ? jsdoc(s.docs) : "";
    if (s.kind === "interface" && s.fields) {
      interfaces.push(
        `${docHeader}export interface ${s.name} {\n${indent(renderInterfaceBody(s.fields, s.index ?? null, options))}\n}`,
      );
    } else if (s.kind === "alias" && s.shape) {
      aliases.push(
        `${docHeader}export type ${s.name} = ${renderTypeNode(shapeToTypeNode(s.shape, options))}`,
      );
    }
  }
  // Emit aliases before interfaces so referenced object shapes are declared last.
  return `export namespace Schemas {\n${indent([...aliases, ...interfaces].join("\n\n"))}\n}`;
}

function renderInterfaceBody(
  fields: ContractField[],
  index: ContractShape | null,
  options: RenderTypeNodeOptions,
): string {
  const lines = fields.map((f) => {
    const docHeader = f.docs ? jsdoc(f.docs) : "";
    const opt = f.required ? "" : "?";
    return `${docHeader}${safeKey(f.name)}${opt}: ${renderTypeNode(shapeToTypeNode(f.shape, options))}`;
  });
  if (index) lines.push(`[key: string]: ${renderTypeNode(shapeToTypeNode(index, options))}`);
  return lines.join("\n");
}
