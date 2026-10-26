import { identity } from "./document-nodes"
import type { DocumentNode, DocumentSet } from "./documents"
import { isRecord } from "./object"
import type { Resolved, SourceIssue, SourceResult } from "./references"
import { inspectObject } from "./references"

/** Path Item method fields, including OpenAPI 3.2's query method in older descriptions. */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"]

/** Effective Path Item fields and their conflicts, retaining each field's original base URI. */
export function selectPathItem(
  documents: DocumentSet,
  node: DocumentNode,
): SourceResult<{ fields: Map<string, DocumentNode>; issues: SourceIssue[] }> {
  const chain: DocumentNode[] = []
  const seen = new Set<string>()
  let current = node
  while (isRecord(current.value)) {
    const id = identity(current)
    if (seen.has(id)) {
      return {
        kind: "error",
        issue: {
          severity: "error",
          code: "circular-ref",
          message: "Reference cycle through a Path Item",
          node,
          key: "$ref",
        },
      }
    }
    seen.add(id)
    chain.push(current)
    const ref = current.value.$ref
    if (typeof ref !== "string") break
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
  const fields = new Map<string, DocumentNode>()
  const issues: SourceIssue[] = []
  for (const link of chain.toReversed()) {
    for (const key of Object.keys(link.value as Record<string, unknown>)) {
      if (key === "$ref") continue
      if (fields.has(key)) {
        issues.push({
          severity: "warning",
          code: "path-item-conflict",
          message: `"${key}" is defined both here and in the referenced Path Item; the local definition is used`,
          node: link,
          key,
        })
      }
      fields.set(key, documents.child(link, key))
    }
  }
  return { kind: "found", value: { fields, issues } }
}

/** Standard methods followed by additional operations; aliases cannot redefine standard methods. */
export function selectOperations(documents: DocumentSet, fields: Map<string, DocumentNode>) {
  const methods: Array<[method: string, node: DocumentNode]> = []
  const issues: SourceIssue[] = []
  for (const method of METHODS) {
    const node = fields.get(method)
    if (node !== undefined) methods.push([method.toUpperCase(), node])
  }
  const additional = fields.get("additionalOperations")
  if (additional !== undefined && isRecord(additional.value)) {
    for (const method of Object.keys(additional.value)) {
      const node = documents.child(additional, method)
      if (METHODS.includes(method.toLowerCase())) {
        issues.push({
          severity: "warning",
          code: "ignored-field",
          message: `additionalOperations cannot redefine ${method}; use the "${method.toLowerCase()}" field`,
          node,
        })
      } else methods.push([method, node])
    }
  }
  return { methods, issues }
}

const LOCATIONS = new Set(["path", "query", "header", "cookie", "querystring"])
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"])

interface ParameterSource {
  at: Resolved
  value: Record<string, unknown>
}

/** Resolve, validate and override parameters before either phase visits their schemas. */
export function selectParameterSources(
  documents: DocumentSet,
  shared: DocumentNode | undefined,
  own: DocumentNode,
) {
  const byKey = new Map<string, ParameterSource>()
  const issues: SourceIssue[] = []
  let pending = false
  for (const list of [shared, own]) {
    if (list === undefined || !Array.isArray(list.value)) continue
    const local = new Set<string>()
    for (const [i] of list.value.entries()) {
      const result = inspectObject(documents, documents.child(list, i))
      if (result.kind === "pending") {
        pending = true
        continue
      }
      if (result.kind === "error") {
        issues.push(result.issue)
        continue
      }
      const at = result.value
      const value = at.node.value
      if (!isRecord(value) || typeof value.name !== "string" || typeof value.in !== "string") {
        issues.push({
          severity: "warning",
          code: "invalid-parameter",
          message: 'A parameter needs string "name" and "in" fields',
          node: at.node,
        })
        continue
      }
      const location = value.in
      if (!LOCATIONS.has(location)) {
        issues.push({
          severity: "warning",
          code: "invalid-parameter",
          message: `Unknown parameter location "${location}"`,
          node: at.node,
          key: "in",
        })
        continue
      }
      if (location === "header" && IGNORED_HEADERS.has(value.name.toLowerCase())) continue
      const key = `${location}:${location === "header" ? value.name.toLowerCase() : value.name}`
      if (local.has(key)) {
        issues.push({
          severity: "warning",
          code: "invalid-parameter",
          message: `Duplicate ${location} parameter "${value.name}"`,
          node: at.node,
        })
      }
      local.add(key)
      byKey.set(key, { at, value })
    }
  }
  const parameters = [...byKey.values()]
  return { parameters, selected: new Set(selectParameters(parameters)), issues, pending }
}

/** Select before loading or compiling schemas: the first querystring replaces ordinary queries. */
function selectParameters<T extends { value: unknown }>(parameters: Iterable<T>): T[] {
  const list = [...parameters]
  const whole = list.find(
    (parameter) => isRecord(parameter.value) && parameter.value.in === "querystring",
  )
  if (whole === undefined) return list
  return list.filter((parameter) => {
    const location = isRecord(parameter.value) ? parameter.value.in : undefined
    return location === "querystring" ? parameter === whole : location !== "query"
  })
}
