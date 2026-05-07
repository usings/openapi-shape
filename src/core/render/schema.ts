import type { TypeNode, SchemaModel, FieldModel } from "../build/ir";
import { indent, jsdoc } from "./format";
import { safeKey } from "../shared/naming";

export function renderTypeNode(node: TypeNode): string {
  switch (node.kind) {
    case "primitive":
      return node.name;
    case "literal":
      return literalToTs(node.value);
    case "ref":
      return node.name;
    case "raw":
      return node.text;
    case "array": {
      const inner = renderTypeNode(node.items);
      return needsParens(node.items) ? `(${inner})[]` : `${inner}[]`;
    }
    case "tuple": {
      const head = node.items.map((i) => renderTypeNode(i)).join(", ");
      if (!node.rest) return `[${head}]`;
      const rest = renderTypeNode(node.rest);
      const restRendered = needsParens(node.rest) ? `(${rest})[]` : `${rest}[]`;
      return head ? `[${head}, ...${restRendered}]` : `[...${restRendered}]`;
    }
    case "record":
      return `Record<string, ${renderTypeNode(node.values)}>`;
    case "object":
      return renderObject(node.fields, node.index);
    case "union":
      return node.members.map((m) => wrapForUnion(m)).join(" | ");
    case "intersection":
      return node.members.map((m) => wrapForIntersection(m)).join(" & ");
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

function wrapForUnion(node: TypeNode): string {
  const r = renderTypeNode(node);
  if (node.kind === "intersection") return `(${r})`;
  return r;
}

function wrapForIntersection(node: TypeNode): string {
  const r = renderTypeNode(node);
  if (node.kind === "union") return `(${r})`;
  return r;
}

function renderObject(fields: FieldModel[], index: TypeNode | null): string {
  const lines: string[] = [];
  for (const f of fields) {
    const docHeader = f.docs ? jsdoc(f.docs) : "";
    const opt = f.required ? "" : "?";
    lines.push(`${docHeader}${safeKey(f.name)}${opt}: ${renderTypeNode(f.type)}`);
  }
  if (index) lines.push(`[key: string]: ${renderTypeNode(index)}`);
  if (lines.length === 0) return "{}";
  return `{\n${indent(lines.join("\n"))}\n}`;
}

export function renderSchemas(schemas: SchemaModel[]): string {
  const aliases: string[] = [];
  const interfaces: string[] = [];
  for (const s of schemas) {
    const docHeader = s.docs ? jsdoc(s.docs) : "";
    if (s.kind === "interface" && s.fields) {
      interfaces.push(
        `${docHeader}export interface ${s.name} {\n${indent(renderInterfaceBody(s.fields))}\n}`,
      );
    } else if (s.kind === "alias" && s.type) {
      aliases.push(`${docHeader}export type ${s.name} = ${renderTypeNode(s.type)}`);
    }
  }
  // Emit aliases before interfaces so referenced object shapes are declared last.
  return [...aliases, ...interfaces].join("\n\n");
}

function renderInterfaceBody(fields: FieldModel[]): string {
  return fields
    .map((f) => {
      const docHeader = f.docs ? jsdoc(f.docs) : "";
      const opt = f.required ? "" : "?";
      return `${docHeader}${safeKey(f.name)}${opt}: ${renderTypeNode(f.type)}`;
    })
    .join("\n");
}
