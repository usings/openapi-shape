import type {
  OpenAPIDocument,
  OpenAPISchema,
  Operation,
  Parameter,
  PathItem,
  RequestBody,
  MediaType,
  HttpMethod,
  Callback,
} from "../openapi/types"
import { HTTP_METHODS, isCallbackReference } from "../openapi/types"
import { appendPointer } from "../shared/pointer"
import { BuildError } from "./errors"
import type { ContractOperation, ContractField, ContractPayload, DocBlock } from "./model"
import { buildResponses, isJsonContentType } from "./outcomes"
import { buildContractType } from "./schema-type"

/**
 * Build endpoint, webhook, and callback operations in declaration order.
 *
 * Operation-level parameters replace path-level parameters with the same
 * `in:name` identity; `paramFields` documents per-location typing. Callbacks,
 * including nested ones, are flattened beside their parent operations. OpenAPI
 * 3.0 operations must declare `responses`; 3.1 operations may omit them.
 */
export function buildOperations(doc: OpenAPIDocument): ContractOperation[] {
  const responsesRequired = /^3\.0\.\d+$/.test(doc.openapi ?? "")
  return [
    ...walkPathItems(doc.paths ?? {}, "endpoint", "/paths", responsesRequired),
    ...walkPathItems(doc.webhooks ?? {}, "webhook", "/webhooks", responsesRequired),
  ]
}

function walkCallbacks(
  callbacks: Record<string, Callback>,
  parentKey: string,
  parentLocation: string,
  responsesRequired: boolean,
  seen: ReadonlySet<Callback> = new Set(),
): ContractOperation[] {
  // Nested callbacks are flattened recursively with chained keys. A chain stops
  // when a callback object repeats within it, which reference resolution and
  // YAML anchors can otherwise turn into an infinite expansion.
  const out: ContractOperation[] = []
  for (const [callbackName, callback] of Object.entries(callbacks)) {
    if (isCallbackReference(callback)) continue
    if (seen.has(callback)) continue
    const chain = new Set(seen).add(callback)
    for (const [expression, callbackPathItem] of Object.entries(callback)) {
      if (!callbackPathItem || typeof callbackPathItem !== "object") continue
      const pathParams = callbackPathItem.parameters ?? []
      for (const method of HTTP_METHODS) {
        const op = callbackPathItem[method]
        if (!op) continue
        const location = appendPointer(
          parentLocation,
          "callbacks",
          callbackName,
          expression,
          method,
        )
        requireResponses(op, location, responsesRequired, "Callback operation")
        const merged = mergeParameters(pathParams, op.parameters ?? [])
        const base = buildBase(method, expression, merged, op, location)
        const key = `${parentKey} > ${callbackName} > ${base.key}`
        out.push({
          ...base,
          kind: "callback",
          key,
          parentKey,
          callbackName,
          expression,
          params: paramFields(merged, "path"),
          source: { location },
        })
        if (op.callbacks) {
          out.push(...walkCallbacks(op.callbacks, key, location, responsesRequired, chain))
        }
      }
    }
  }
  return out
}

function requireResponses(
  operation: Operation,
  location: string,
  required: boolean,
  label = "Operation",
): void {
  if (required && !operation.responses) {
    throw new BuildError(`${label} is missing required responses at ${location}`)
  }
}
function walkPathItems(
  items: Record<string, PathItem>,
  kind: "endpoint" | "webhook",
  locationRoot: "/paths" | "/webhooks",
  responsesRequired: boolean,
): ContractOperation[] {
  const out: ContractOperation[] = []
  for (const [label, pathItem] of Object.entries(items)) {
    if (!pathItem || typeof pathItem !== "object") continue
    const pathParams = pathItem.parameters ?? []
    for (const method of HTTP_METHODS) {
      const op = pathItem[method]
      if (!op) continue
      const location = appendPointer(locationRoot, label, method)
      requireResponses(op, location, responsesRequired)
      const merged = mergeParameters(pathParams, op.parameters ?? [])
      const base = buildBase(method, label, merged, op, location)
      const source = { location }
      out.push(
        kind === "endpoint"
          ? { ...base, kind: "endpoint", path: label, params: paramFields(merged, "path"), source }
          : { ...base, kind: "webhook", name: label, source },
      )
      if (op.callbacks)
        out.push(...walkCallbacks(op.callbacks, base.key, location, responsesRequired))
    }
  }
  return out
}

function buildBase(
  method: HttpMethod,
  label: string,
  merged: Parameter[],
  op: Operation,
  location: string,
) {
  return {
    key: `${method.toUpperCase()} ${label}`,
    method,
    operationId: op.operationId,
    tags: op.tags ?? [],
    summary: op.summary,
    description: op.description,
    deprecated: op.deprecated === true,
    query: paramFields(merged, "query"),
    headers: paramFields(merged, "header"),
    cookies: paramFields(merged, "cookie"),
    body: buildBody(op.requestBody),
    responses: buildResponses(op.responses ?? {}, appendPointer(location, "responses")),
  }
}

function mergeParameters(a: Parameter[], b: Parameter[]): Parameter[] {
  const seen = new Map<string, Parameter>()
  for (const p of [...a, ...b]) {
    if (typeof p.in !== "string" || typeof p.name !== "string") continue
    seen.set(`${p.in}:${p.name}`, p)
  }
  return [...seen.values()]
}

/**
 * Build contract fields for one parameter location.
 *
 * Path and header parameters render as strings regardless of schema type;
 * query and cookie parameters retain their schema types. Path parameters are
 * always required.
 */
function paramFields(
  parameters: Parameter[],
  location: "path" | "query" | "header" | "cookie",
): ContractField[] {
  const typed = location === "query" || location === "cookie"
  return parameters
    .filter((p) => p.in === location)
    .map((p) => {
      const field: ContractField = {
        name: p.name as string,
        required: location === "path" || p.required === true,
        type: typed ? buildContractType(parameterSchema(p)) : { kind: "scalar", name: "string" },
      }
      const docs = docBlockFromParameter(p)
      if (docs !== undefined) field.docs = docs
      return field
    })
}

/**
 * Select the schema of a parameter declared with either `schema` or `content`.
 * Content entries prefer JSON media types, mirroring request body selection.
 */
function parameterSchema(p: Parameter): OpenAPISchema | undefined {
  if (p.schema !== undefined || !p.content) return p.schema
  return selectMediaSchema(p.content)?.schema
}

/** First JSON-family media entry with a schema, else the first entry with a schema. */
function selectMediaSchema(
  content: Record<string, MediaType>,
): { schema: OpenAPISchema; json: boolean } | null {
  for (const [ct, media] of Object.entries(content)) {
    if (isJsonContentType(ct) && media.schema !== undefined) {
      return { schema: media.schema, json: true }
    }
  }
  for (const media of Object.values(content)) {
    if (media.schema !== undefined) return { schema: media.schema, json: false }
  }
  return null
}

function buildBody(rb: RequestBody | undefined): ContractPayload {
  if (!rb?.content) return { kind: "none" }
  const selected = selectMediaSchema(rb.content)
  if (!selected) return { kind: "none" }
  return {
    kind: selected.json ? "json" : "passthrough",
    required: rb.required === true,
    type: buildContractType(selected.schema),
  }
}

function docBlockFromParameter(p: Parameter): DocBlock | undefined {
  const out: DocBlock = {}
  if (p.description) out.description = p.description
  if (p.deprecated) out.deprecated = true
  return Object.keys(out).length === 0 ? undefined : out
}
