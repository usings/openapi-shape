import type { ContractShape, ContractSchema, ContractField } from "../contract/contract"
import { safeKey } from "../shared/naming"
import { indent, jsdoc } from "./format"
import type { DeclarationOptions } from "./options"
import type { TypeNode, TypeField } from "./type-node"
import { schemaToTypeNode, widenIndexNode } from "./type-node"

export interface RenderTypeNodeOptions {
  /** Prefix to add to schema references, for example `Schemas.`. */
  refPrefix?: string
  /** Custom OpenAPI `format` to TypeScript type-expression mappings. */
  formats?: DeclarationOptions["formats"]
}

export function renderTypeNode(node: TypeNode, options: RenderTypeNodeOptions = {}): string {
  switch (node.kind) {
    case "primitive":
      return node.name
    case "literal":
      return literalToTs(node.value)
    case "ref":
      return `${options.refPrefix ?? ""}${node.name}`
    case "raw":
      return node.text
    case "array": {
      const inner = renderTypeNode(node.items, options)
      return needsParens(node.items) ? `(${inner})[]` : `${inner}[]`
    }
    case "tuple": {
      const head = node.items.map((i) => renderTypeNode(i, options)).join(", ")
      if (!node.rest) return `[${head}]`
      const rest = renderTypeNode(node.rest, options)
      const restRendered = needsParens(node.rest) ? `(${rest})[]` : `${rest}[]`
      return head ? `[${head}, ...${restRendered}]` : `[...${restRendered}]`
    }
    case "record":
      return `Record<string, ${renderTypeNode(node.values, options)}>`
    case "object":
      return renderObject(node.fields, node.index, options)
    case "union":
      return node.members.map((m) => wrapForUnion(m, options)).join(" | ")
    case "intersection":
      return node.members.map((m) => wrapForIntersection(m, options)).join(" & ")
  }
}

function literalToTs(value: string | number | boolean | null): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  return String(value)
}

function needsParens(node: TypeNode): boolean {
  return node.kind === "union" || node.kind === "intersection"
}

function wrapForUnion(node: TypeNode, options: RenderTypeNodeOptions): string {
  const r = renderTypeNode(node, options)
  if (node.kind === "intersection") return `(${r})`
  return r
}

function wrapForIntersection(node: TypeNode, options: RenderTypeNodeOptions): string {
  const r = renderTypeNode(node, options)
  if (node.kind === "union") return `(${r})`
  return r
}

function renderObject(
  fields: TypeField[],
  index: TypeNode | null,
  options: RenderTypeNodeOptions,
): string {
  const lines = objectFieldLines(fields, index, options)
  if (lines.length === 0) return "{}"
  return `{\n${indent(lines.join("\n"))}\n}`
}

function objectFieldLines(
  fields: TypeField[],
  index: TypeNode | null,
  options: RenderTypeNodeOptions,
): string[] {
  const lines = fields.map((f) => {
    const docHeader = f.docs ? jsdoc(f.docs) : ""
    const opt = f.required ? "" : "?"
    return `${docHeader}${safeKey(f.name)}${opt}: ${renderTypeNode(f.type, options)}`
  })
  if (index) lines.push(`[key: string]: ${renderTypeNode(index, options)}`)
  return lines
}

export function shapeToTypeNode(
  shape: ContractShape,
  options: RenderTypeNodeOptions = {},
): TypeNode {
  if (shape.kind === "primitive") return { kind: "primitive", name: shape.name }
  return schemaToTypeNode(shape.schema, options)
}

export function renderSchemas(
  schemas: ContractSchema[],
  options: RenderTypeNodeOptions = {},
): string {
  const aliases: string[] = []
  const interfaces: string[] = []
  for (const s of schemas) {
    const docHeader = s.docs ? jsdoc(s.docs) : ""
    if (s.kind === "interface" && s.fields) {
      interfaces.push(
        `${docHeader}export interface ${s.name} {\n${indent(renderInterfaceBody(s.fields, s.index ?? null, options))}\n}`,
      )
    } else if (s.kind === "alias" && s.shape) {
      aliases.push(
        `${docHeader}export type ${s.name} = ${renderTypeNode(shapeToTypeNode(s.shape, options))}`,
      )
    }
  }
  return `export namespace Schemas {\n${indent([...aliases, ...interfaces].join("\n\n"))}\n}`
}

function renderInterfaceBody(
  fields: ContractField[],
  index: ContractShape | null,
  options: RenderTypeNodeOptions,
): string {
  const fieldNodes: TypeField[] = fields.map((f) => ({
    name: f.name,
    required: f.required,
    type: shapeToTypeNode(f.shape, options),
    docs: f.docs,
  }))
  const widened = index ? widenIndexNode(shapeToTypeNode(index, options), fieldNodes) : null
  // References inside the namespace do not need the `Schemas.` prefix.
  return objectFieldLines(fieldNodes, widened, {}).join("\n")
}
