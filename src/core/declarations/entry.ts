import type {
  ContractPayload,
  ContractOperation,
  ContractOutcome,
  ContractField,
} from "../contract/model"
import { indent, indentContinuation, jsdoc } from "./format"
import type { RenderTypeOptions } from "./render-type"
import { objectFieldLines, renderContractType } from "./render-type"

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

/** Callers pass fully resolved render options, including the schema ref prefix. */
export function renderParam(fields: ContractField[], options: RenderTypeOptions = {}): string {
  if (fields.length === 0) return "void"
  const lines = objectFieldLines(fields, undefined, options)
  if (!fields.some((f) => f.docs)) return `{ ${lines.join("; ")} }`
  return `{\n${indent(lines.join("\n"))}\n}`
}

export function renderBody(
  body: ContractPayload,
  key: string,
  options: RenderTypeOptions = {},
): string {
  if (body.kind === "none") return `${key}: void`
  const t = indentContinuation(renderContractType(body.type, options), "    ")
  return body.required ? `${key}: ${t}` : `${key}?: ${t}`
}

export function renderResponseMap(
  responses: ContractOutcome[],
  options: RenderTypeOptions = {},
): string {
  if (responses.length === 0) return "unknown"
  const entries = responses.map((r) => `"${r.status}": ${renderContractType(r.type, options)}`)
  return `{ ${entries.join("; ")} }`
}
