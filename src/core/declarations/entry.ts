import type {
  ContractPayload,
  ContractOperation,
  ContractOutcome,
  ContractField,
} from "../contract/contract"
import { safeKey } from "../shared/naming"
import { indent, indentContinuation, jsdoc } from "./format"
import type { RenderTypeOptions } from "./render-type"
import { renderContractType } from "./render-type"

const schemaRefOptions = { refPrefix: "Schemas." } as const

export function entryDocHeader(entry: ContractOperation): string {
  return jsdoc(
    {
      summary: entry.summary,
      description: entry.description,
      deprecated: entry.deprecated,
    },
    "  ",
  )
}

export function renderParam(fields: ContractField[], options: RenderTypeOptions = {}): string {
  if (fields.length === 0) return "void"
  const hasDocs = fields.some((f) => f.docs?.description || f.docs?.deprecated)
  const renderOptions = { ...options, ...schemaRefOptions }
  const renderField = (f: ContractField) => {
    const opt = f.required ? "" : "?"
    return `${safeKey(f.name)}${opt}: ${renderContractType(f.shape, renderOptions)}`
  }
  if (!hasDocs) return `{ ${fields.map((f) => renderField(f)).join("; ")} }`
  const body = fields.map((f) => `${jsdoc(f.docs ?? {})}${renderField(f)}`).join("\n")
  return `{\n${indent(body)}\n}`
}

export function renderBody(
  body: ContractPayload,
  key: string,
  options: RenderTypeOptions = {},
): string {
  if (body.kind === "none") return `${key}: void`
  const renderOptions = { ...options, ...schemaRefOptions }
  const t = indentContinuation(renderContractType(body.shape, renderOptions), "    ")
  return body.required ? `${key}: ${t}` : `${key}?: ${t}`
}

export function renderResponseMap(
  responses: ContractOutcome[],
  options: RenderTypeOptions = {},
): string {
  if (responses.length === 0) return "unknown"
  const renderOptions = { ...options, ...schemaRefOptions }
  const entries = responses.map(
    (r) => `"${r.status}": ${renderContractType(r.shape, renderOptions)}`,
  )
  return `{ ${entries.join("; ")} }`
}
