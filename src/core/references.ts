import type { BuildContext } from "./build-context"
import type { DiagnosticCode } from "./diagnostics"
import { identity } from "./document-nodes"
import type { DocumentNode, DocumentSet } from "./documents"
import { isRecord } from "./object"

export interface Resolved {
  node: DocumentNode
  /** 3.1+: `summary`/`description` next to `$ref` override the target's. */
  summary?: string
  description?: string
}

/** A source problem retained until compilation, when diagnostics are emitted in source order. */
export interface SourceIssue {
  severity: "error" | "warning"
  code: DiagnosticCode
  message: string
  node: DocumentNode
  key?: string
}

export type SourceResult<T> =
  | { kind: "found"; value: T }
  | { kind: "pending" }
  | { kind: "error"; issue: SourceIssue }

export function reportSourceIssues(context: BuildContext, issues: SourceIssue[]): void {
  for (const issue of issues) {
    if (issue.severity === "error") context.error(issue.code, issue.message, issue.node, issue.key)
    else context.warn(issue.code, issue.message, issue.node, issue.key)
  }
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
  const result = inspectObject(context.documents, node)
  if (result.kind === "error") reportSourceIssues(context, [result.issue])
  return result.kind === "found" ? result.value : undefined
}

/** Follow the same Reference Object chain during discovery and compilation, without reporting. */
export function inspectObject(documents: DocumentSet, node: DocumentNode): SourceResult<Resolved> {
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
      return {
        kind: "error",
        issue: {
          severity: "error",
          code: "circular-ref",
          message: `Reference cycle through "${ref}"`,
          node,
          key: "$ref",
        },
      }
    }
    seen.add(id)
    const resolution = documents.resolve(ref, current)
    if (resolution.kind === "pending") return resolution
    if (resolution.kind === "error") {
      return {
        kind: "error",
        issue: {
          severity: "error",
          code: "unresolved-ref",
          message: `Cannot resolve $ref "${ref}": ${resolution.message}`,
          node: current,
          key: "$ref",
        },
      }
    }
    current = resolution.node
  }
  out.node = current
  return { kind: "found", value: out }
}
