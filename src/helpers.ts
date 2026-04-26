export function indent(text: string, depth: number = 1): string {
  const prefix = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

export function jsdoc(
  parts: { description?: string; summary?: string; deprecated?: boolean },
  indent = "",
): string {
  const lines: string[] = [];
  if (parts.summary) lines.push(...parts.summary.trim().split("\n"));
  if (parts.description) {
    if (lines.length) lines.push("");
    lines.push(...parts.description.trim().split("\n"));
  }
  if (parts.deprecated) {
    if (lines.length) lines.push("");
    lines.push("@deprecated");
  }
  if (lines.length === 0) return "";
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((line) => `${indent} *${line ? " " + line : ""}`).join("\n")}\n${indent} */\n`;
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

const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const RESERVED_IDENTIFIERS = new Set(
  (
    "abstract any as asserts async await boolean break case catch class const constructor continue " +
    "debugger declare default delete do else enum export extends false finally for from function " +
    "get if implements import in infer instanceof interface is keyof let module namespace never " +
    "new null number object of package private protected public readonly require return satisfies " +
    "set static string super switch symbol this throw true try type typeof undefined unique unknown " +
    "var void while with yield"
  ).split(" "),
);

export function safeKey(name: string): string {
  return VALID_IDENT.test(name) ? name : JSON.stringify(name);
}

export function safeIdentifier(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (/^[0-9]/.test(out)) out = "_" + out;
  if (RESERVED_IDENTIFIERS.has(out)) out = "_" + out;
  return out;
}
