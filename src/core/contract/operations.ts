import { appendPointer } from "../shared/pointer"
import type { ContractOperation, ContractField, ContractPayload, DocBlock } from "./contract"
import { BuildError } from "./errors"
import type {
  OpenAPIDocument,
  Operation,
  Parameter,
  PathItem,
  RequestBody,
  MediaType,
  HttpMethod,
  Callback,
} from "./openapi"
import { HTTP_METHODS, isCallbackReference } from "./openapi"
import { buildResponses, isJsonContentType } from "./outcomes"
import { buildContractType } from "./schema-type"

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
): ContractOperation[] {
  const out: ContractOperation[] = []
  for (const [callbackName, callback] of Object.entries(callbacks)) {
    if (isCallbackReference(callback)) continue
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
        out.push({
          ...base,
          kind: "callback",
          key: `${parentKey} > ${callbackName} > ${base.key}`,
          parentKey,
          callbackName,
          expression,
          source: { location },
        })
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
          ? { ...base, kind: "endpoint", path: label, params: buildParams(merged), source }
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
    query: buildQuery(merged),
    headers: buildHeaders(merged),
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

function buildParams(parameters: Parameter[]): ContractField[] {
  return parameters
    .filter((p) => p.in === "path")
    .map((p) => ({
      name: p.name as string,
      required: true,
      type: { kind: "scalar", name: "string" } as const,
      docs: docBlockFromParameter(p),
    }))
}

function buildQuery(parameters: Parameter[]): ContractField[] {
  return parameters
    .filter((p) => p.in === "query")
    .map((p) => ({
      name: p.name as string,
      required: p.required === true,
      type: buildContractType(p.schema),
      docs: docBlockFromParameter(p),
    }))
}

function buildHeaders(parameters: Parameter[]): ContractField[] {
  return parameters
    .filter((p) => p.in === "header")
    .map((p) => ({
      name: p.name as string,
      required: p.required === true,
      type: { kind: "scalar", name: "string" },
      docs: docBlockFromParameter(p),
    }))
}

function buildBody(rb: RequestBody | undefined): ContractPayload {
  if (!rb?.content) return { kind: "none" }
  const required = rb.required === true
  for (const [ct, media] of Object.entries(rb.content)) {
    if (isJsonContentType(ct) && (media as MediaType).schema) {
      return {
        kind: "json",
        required,
        type: buildContractType((media as MediaType).schema),
      }
    }
  }
  for (const [, media] of Object.entries(rb.content)) {
    if ((media as MediaType).schema) {
      return {
        kind: "passthrough",
        required,
        type: buildContractType((media as MediaType).schema),
      }
    }
  }
  return { kind: "none" }
}

function docBlockFromParameter(p: Parameter): DocBlock | undefined {
  const out: DocBlock = {}
  if (p.description) out.description = p.description
  if (p.deprecated) out.deprecated = true
  return Object.keys(out).length === 0 ? undefined : out
}
