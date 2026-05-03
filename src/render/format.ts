export function indent(text: string, depth: number = 1): string {
  const prefix = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

export function escapeCommentText(text: string): string {
  return text.replaceAll("*/", "*\\/");
}

export function jsdoc(
  parts: { description?: string; summary?: string; deprecated?: boolean },
  indentStr = "",
): string {
  const lines: string[] = [];
  if (parts.summary) lines.push(...escapeCommentText(parts.summary.trim()).split("\n"));
  if (parts.description) {
    if (lines.length) lines.push("");
    lines.push(...escapeCommentText(parts.description.trim()).split("\n"));
  }
  if (parts.deprecated) {
    if (lines.length) lines.push("");
    lines.push("@deprecated");
  }
  if (lines.length === 0) return "";
  if (lines.length === 1) return `${indentStr}/** ${lines[0]} */\n`;
  return `${indentStr}/**\n${lines
    .map((line) => `${indentStr} *${line ? " " + line : ""}`)
    .join("\n")}\n${indentStr} */\n`;
}

export function indentContinuation(text: string, prefix: string): string {
  if (!text.includes("\n")) return text;
  return text
    .split("\n")
    .map((line, lineIndex) => (lineIndex === 0 ? line : prefix + line))
    .join("\n");
}

export function interfaceDecl(name: string, body: string): string {
  return `export interface ${name} {\n${indent(body)}\n}`;
}

export function typeDecl(name: string, type: string): string {
  return `export type ${name} = ${type}`;
}
