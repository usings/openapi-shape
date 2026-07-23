import type { ContractField, ContractType } from "../contract/model"
import { safeKey } from "../shared/naming"
import { indent, jsdoc } from "./format"

export interface RenderTypeOptions {
  /** Prefix to add to schema references, for example `Schemas.`. */
  refPrefix?: string
  /** Custom OpenAPI `format` to TypeScript type-expression mappings. */
  formats?: Record<string, string>
}

/**
 * A rendered type expression together with its effective node kind.
 *
 * Unions collapse to their single member after render-time deduplication, so
 * parenthesization decisions must use the collapsed kind instead of the
 * original node kind.
 */
interface Rendered {
  text: string
  kind: ContractType["kind"]
}

/** Render a contract type as a TypeScript type expression. */
export function renderContractType(type: ContractType, options: RenderTypeOptions = {}): string {
  return renderNode(type, options).text
}

function renderNode(node: ContractType, options: RenderTypeOptions): Rendered {
  switch (node.kind) {
    case "unknown":
    case "never":
    case "void":
      return { text: node.kind, kind: node.kind }
    case "scalar":
      return { text: scalarText(node.name, node.format, options), kind: node.kind }
    case "binary":
      // Media-type-derived binary nodes carry no format; the `binary` mapping
      // still applies so user format overrides reach binary response bodies.
      return { text: formatMapping(node.format ?? "binary", options) ?? "Blob", kind: node.kind }
    case "literal":
      return { text: literalToTs(node.value), kind: node.kind }
    case "reference":
      return { text: `${options.refPrefix ?? ""}${node.name}`, kind: node.kind }
    case "array": {
      const inner = renderNode(node.items, options)
      return { text: `${wrapForPostfix(inner)}[]`, kind: node.kind }
    }
    case "tuple": {
      const head = node.items.map((i) => renderNode(i, options).text).join(", ")
      if (!node.rest) return { text: `[${head}]`, kind: node.kind }
      const rest = `${wrapForPostfix(renderNode(node.rest, options))}[]`
      return { text: head ? `[${head}, ...${rest}]` : `[...${rest}]`, kind: node.kind }
    }
    case "record":
      return {
        text: `Record<string, ${renderNode(node.values, options).text}>`,
        kind: node.kind,
      }
    case "object": {
      const lines = objectFieldLines(node.fields, node.index, options)
      if (lines.length === 0) return { text: "{}", kind: node.kind }
      return { text: `{\n${indent(lines.join("\n"))}\n}`, kind: node.kind }
    }
    case "union":
      return renderUnion(node.members.map((m) => renderNode(m, options)))
    case "intersection": {
      const members = node.members.map((m) => renderNode(m, options))
      // An empty intersection constrains nothing.
      if (members.length === 0) return { text: "unknown", kind: "unknown" }
      if (members.length === 1) return members[0]
      const text = members.map((m) => (m.kind === "union" ? `(${m.text})` : m.text)).join(" & ")
      return { text, kind: node.kind }
    }
  }
}

/**
 * Render field and index-signature lines for an object type or interface body.
 *
 * The index value type is widened with every declared field type, as required
 * by TypeScript index signatures; optional fields also contribute `undefined`.
 */
export function objectFieldLines(
  fields: ContractField[],
  index: ContractType | undefined,
  options: RenderTypeOptions,
): string[] {
  const renderedFields = fields.map((f) => renderNode(f.type, options))
  const lines = fields.map((f, i) => {
    const docHeader = f.docs ? jsdoc(f.docs) : ""
    const opt = f.required ? "" : "?"
    return `${docHeader}${safeKey(f.name)}${opt}: ${renderedFields[i].text}`
  })
  if (index)
    lines.push(`[key: string]: ${widenedIndexText(index, fields, renderedFields, options)}`)
  return lines
}

function widenedIndexText(
  index: ContractType,
  fields: ContractField[],
  renderedFields: Rendered[],
  options: RenderTypeOptions,
): string {
  if (index.kind === "unknown") return "unknown"
  const members = index.kind === "union" ? index.members : [index]
  const rendered: Rendered[] = [...members.map((m) => renderNode(m, options)), ...renderedFields]
  if (fields.some((f) => !f.required)) rendered.push({ text: "undefined", kind: "scalar" })
  return renderUnion(rendered).text
}

/**
 * Join union members, deduplicating by rendered text. A union that collapses
 * to one member returns that member's kind so wrapping decisions stay correct.
 */
function renderUnion(members: Rendered[]): Rendered {
  // An empty union permits nothing. The contract builder never produces one,
  // but rendering must not emit an empty type expression.
  if (members.length === 0) return { text: "never", kind: "never" }
  const seen = new Set<string>()
  const dedup: Rendered[] = []
  for (const m of members) {
    if (seen.has(m.text)) continue
    seen.add(m.text)
    dedup.push(m)
  }
  if (dedup.length === 1) return dedup[0]
  const text = dedup.map((m) => (m.kind === "intersection" ? `(${m.text})` : m.text)).join(" | ")
  return { text, kind: "union" }
}

function wrapForPostfix(inner: Rendered): string {
  return inner.kind === "union" || inner.kind === "intersection" ? `(${inner.text})` : inner.text
}

function scalarText(
  name: "string" | "number" | "boolean" | "null",
  format: string | undefined,
  options: RenderTypeOptions,
): string {
  if (name === "string" || name === "number") {
    const mapped = formatMapping(format, options)
    if (mapped !== undefined) return mapped
  }
  return name
}

function formatMapping(format: string | undefined, options: RenderTypeOptions): string | undefined {
  if (format === undefined || !options.formats) return undefined
  return Object.hasOwn(options.formats, format) ? options.formats[format] : undefined
}

function literalToTs(value: string | number | boolean | null): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  return String(value)
}
