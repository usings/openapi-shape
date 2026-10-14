import type { Node } from "../openapi/documents"
import { isRecord } from "../shared/object"
import { appendPointer } from "../shared/pointer"
import { identity } from "./nodes"
import type { SchemaBuilder } from "./schema"

export interface Resolved {
  node: Node
  /** 3.1+: `summary`/`description` next to `$ref` override the target's. */
  summary?: string
  description?: string
}

/**
 * Follow Reference Objects (`$ref` in a non-schema position) to their target.
 * The target is read as the object type of the referencing position.
 * Returns `undefined` when the reference cannot be resolved (already reported)
 * or its document is still loading.
 */
export function resolveObject(builder: SchemaBuilder, node: Node): Resolved | undefined {
  const out: Resolved = { node }
  const seen = new Set<string>()
  let current = node
  while (isRecord(current.value) && typeof current.value.$ref === "string") {
    const ref = current.value.$ref
    if (current.doc.version !== "3.0") {
      if (out.summary === undefined && typeof current.value.summary === "string") {
        out.summary = current.value.summary
      }
      if (out.description === undefined && typeof current.value.description === "string") {
        out.description = current.value.description
      }
    }
    const id = identity(current)
    if (seen.has(id)) {
      builder.diagnostics.error(
        "circular-ref",
        `Reference cycle through "${ref}"`,
        builder.docs.locate(node.doc, appendPointer(node.pointer, "$ref")),
      )
      return undefined
    }
    seen.add(id)
    const resolution = builder.docs.resolve(ref, current)
    if (resolution.kind === "pending") return undefined
    if (resolution.kind === "error") {
      builder.diagnostics.error(
        "unresolved-ref",
        `Cannot resolve $ref "${ref}": ${resolution.message}`,
        builder.docs.locate(current.doc, appendPointer(current.pointer, "$ref")),
      )
      return undefined
    }
    current = resolution.node
  }
  out.node = current
  return out
}
