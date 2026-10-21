import type { BuildContext } from "./build-context"
import { identity } from "./document-nodes"
import type { DocumentNode } from "./documents"
import { isRecord } from "./object"

export interface Resolved {
  node: DocumentNode
  /** 3.1+: `summary`/`description` next to `$ref` override the target's. */
  summary?: string
  description?: string
}

/** A schema's references, `$ref` first; `$dynamicRef` is resolved statically, as if it were `$ref`. */
export function referencesOf(schema: unknown): Array<["$ref" | "$dynamicRef", string]> {
  const out: Array<["$ref" | "$dynamicRef", string]> = []
  if (!isRecord(schema)) return out
  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    const ref = schema[keyword]
    if (typeof ref === "string") out.push([keyword, ref])
  }
  return out
}

/**
 * Follow Reference Objects (`$ref` in a non-schema position) to their target. The target is read as
 * the object type of the referencing position. Returns `undefined` when the reference cannot be
 * resolved (already reported) or its document is still loading.
 */
export function resolveObject(context: BuildContext, node: DocumentNode): Resolved | undefined {
  const out: Resolved = { node }
  const seen = new Set<string>()
  let current = node
  while (isRecord(current.value) && typeof current.value.$ref === "string") {
    const ref = current.value.$ref
    if (current.document.version !== "3.0") {
      if (out.summary === undefined && typeof current.value.summary === "string") {
        out.summary = current.value.summary
      }
      if (out.description === undefined && typeof current.value.description === "string") {
        out.description = current.value.description
      }
    }
    const id = identity(current)
    if (seen.has(id)) {
      context.error("circular-ref", `Reference cycle through "${ref}"`, node, "$ref")
      return undefined
    }
    seen.add(id)
    const resolution = context.documents.resolve(ref, current)
    if (resolution.kind === "pending") return undefined
    if (resolution.kind === "error") {
      context.error(
        "unresolved-ref",
        `Cannot resolve $ref "${ref}": ${resolution.message}`,
        current,
        "$ref",
      )
      return undefined
    }
    current = resolution.node
  }
  out.node = current
  return out
}
