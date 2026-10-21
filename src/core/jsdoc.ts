import type { Annotations } from "./model"

/** A JSDoc block followed by a newline, or `""` when there is nothing to say. */
export function jsdoc(annotations: Annotations | undefined): string {
  if (annotations === undefined) return ""
  const paragraphs = [annotations.title, annotations.summary, annotations.description].filter(
    (p): p is string => p !== undefined,
  )
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    if (lines.length > 0) lines.push("")
    lines.push(...comment(paragraph).split("\n"))
  }
  const tags: string[] = []
  if (annotations.deprecated) tags.push("@deprecated")
  for (const [name, value] of annotations.tags ?? []) {
    tags.push(value === "" ? `@${name}` : `@${name} ${comment(value).replaceAll("\n", " ")}`)
  }
  if (tags.length > 0 && lines.length > 0) lines.push("")
  lines.push(...tags)
  if (lines.length === 0) return ""
  if (lines.length === 1) return `/** ${lines[0]} */\n`
  return `/**\n${lines.map((line) => (line === "" ? " *" : ` * ${line}`)).join("\n")}\n */\n`
}

/** Text inside a block comment: no premature `*\/`. */
function comment(value: string): string {
  return text(value).replaceAll("*/", "*\\/")
}

/**
 * Comment text: unified line breaks (JavaScript also ends lines at U+2028/U+2029), trimmed line
 * ends.
 */
export function text(value: string): string {
  return value
    .replaceAll(/\r\n?|[\u2028\u2029]/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
}

/** Prefix every line after the first, for embedding multi-line text. */
export function indentTail(value: string, prefix: string): string {
  return value.replaceAll("\n", `\n${prefix}`).replaceAll(/\n[ \t]+(?=\n)/g, "\n")
}
