import type { BuildContext } from "./build-context"
import { identity } from "./document-nodes"
import type { DocumentNode } from "./documents"
import { isRecord } from "./object"

/**
 * Record every root alternative before choosing defaults. A missing named property or an opaque
 * schema is unknown evidence, never permission to select a different alternative's content type.
 */
export function formContentTypes(
  context: BuildContext,
  node: DocumentNode,
): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>()
  const alternatives = variants(context, node, new Set())
  if (alternatives === undefined) {
    context.warn(
      "ignored-field",
      "Cannot infer form property defaults through conditional, recursive or overly complex schema composition; specify field encodings or supply an encoded body",
      node,
    )
    return result
  }
  const fields = alternatives.map((alternative) => {
    const properties = new Map<string, DocumentNode[]>()
    for (const source of alternative) {
      if (!isRecord(source.value) || !isRecord(source.value.properties)) continue
      for (const name of Object.keys(source.value.properties)) {
        const property = context.documents.child(source, "properties", name)
        properties.set(name, [...(properties.get(name) ?? []), property])
      }
    }
    return properties
  })
  const names = new Set(fields.flatMap((properties) => [...properties.keys()]))
  for (const name of names) {
    const media = new Set(
      fields.map((properties) => {
        const sources = properties.get(name)
        return sources === undefined ? undefined : defaultFormContentType(context, sources)
      }),
    )
    result.set(name, media.size === 1 ? [...media][0] : undefined)
  }
  return result
}

/** Only select a default when all schema alternatives determine the same media type. */
function defaultFormContentType(
  context: BuildContext,
  nodes: DocumentNode[],
  item = false,
  seen = new Set<string>(),
): string | undefined {
  const alternatives = combine(nodes.map((node) => variants(context, node, seen)))
  if (alternatives === undefined || alternatives.length === 0) return undefined
  const media = new Set(alternatives.map((sources) => contentType(context, sources, item, seen)))
  return media.size === 1 ? [...media][0] : undefined
}

function contentType(
  context: BuildContext,
  sources: DocumentNode[],
  item: boolean,
  seen: Set<string>,
): string | undefined {
  let types: Set<string> | undefined
  for (const source of sources) {
    const value = source.value
    if (!isRecord(value)) continue
    const declared =
      typeof value.type === "string"
        ? [value.type]
        : Array.isArray(value.type)
          ? value.type.filter((type): type is string => typeof type === "string")
          : undefined
    if (declared)
      types =
        types === undefined
          ? new Set(declared)
          : new Set([...types].filter((type) => declared.includes(type)))
  }
  if (types === undefined) return "application/octet-stream"
  types.delete("null")
  const media = new Set<string | undefined>()
  for (const type of types) {
    if (type === "object" || (type === "array" && item)) media.add("application/json")
    else if (type === "array") {
      const items: DocumentNode[] = []
      const next = new Set([...seen, ...sources.map((source) => identity(source))])
      for (const source of sources) {
        if (!isRecord(source.value)) continue
        // Heterogeneous tuples need a positional encoding, which named fields cannot express.
        if (Array.isArray(source.value.prefixItems) || Array.isArray(source.value.items))
          return undefined
        if (source.value.items !== undefined && source.value.items !== false)
          items.push(context.documents.child(source, "items"))
      }
      media.add(
        items.length === 0
          ? "application/octet-stream"
          : defaultFormContentType(context, items, true, next),
      )
    } else if (["string", "number", "integer", "boolean"].includes(type)) {
      const binary =
        type === "string" &&
        sources.some(
          (source) =>
            isRecord(source.value) &&
            (source.value.contentEncoding !== undefined ||
              source.value.format === "binary" ||
              (source.document.version === "3.0" && source.value.format === "byte")),
        )
      media.add(binary ? "application/octet-stream" : "text/plain")
    } else if (type === "file") media.add("application/octet-stream")
    else media.add(undefined)
  }
  return media.size === 1 ? [...media][0] : undefined
}

/** Schema sources for a single alternative, keeping reference siblings and conjunctive annotations. */
function variants(
  context: BuildContext,
  node: DocumentNode,
  seen: Set<string>,
): DocumentNode[][] | undefined {
  const id = identity(node)
  if (seen.has(id)) return undefined
  const next = new Set(seen).add(id)
  if (!isRecord(node.value)) return [[node]]
  // Conditional schemas can change type and encoding annotations for individual values. Do not
  // infer a single wire representation without evaluating the condition, including at the root.
  if (
    "if" in node.value ||
    "then" in node.value ||
    "else" in node.value ||
    "dependentSchemas" in node.value
  )
    return undefined
  const groups: Array<DocumentNode[][] | undefined> = [[[node]]]
  for (const child of references(context, node)) groups.push(variants(context, child, next))
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (!Array.isArray(node.value[keyword])) continue
    const children = node.value[keyword].map((_, index) =>
      variants(context, context.documents.child(node, keyword, index), next),
    )
    if (keyword === "allOf") groups.push(...children)
    else
      groups.push(
        children.some((child) => child === undefined)
          ? undefined
          : children.flatMap((child) => child ?? []),
      )
  }
  return combine(groups)
}

/** Bound default inference independently of type generation; ambiguous defaults produce a warning. */
function combine(groups: Array<DocumentNode[][] | undefined>): DocumentNode[][] | undefined {
  let out: DocumentNode[][] = [[]]
  for (const group of groups) {
    if (group === undefined || out.length * group.length > 64) return undefined
    const combined: DocumentNode[][] = []
    for (const left of out) for (const right of group) combined.push([...left, ...right])
    out = combined
  }
  return out
}

function references(context: BuildContext, node: DocumentNode): DocumentNode[] {
  if (!isRecord(node.value)) return []
  const ref = node.value
  return ["$ref", "$dynamicRef"].flatMap((keyword) => {
    if (typeof ref[keyword] !== "string") return []
    const resolved = context.documents.resolveSchema(ref[keyword], node)
    return resolved.kind === "found" ? [resolved.node] : []
  })
}
