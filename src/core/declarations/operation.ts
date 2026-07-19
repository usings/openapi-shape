import type { ContractField, ContractOperation } from "../contract/model"
import { safeKey } from "../shared/naming"
import { entryDocHeader, renderBody, renderParam, renderResponseMap } from "./entry"
import { indentContinuation } from "./format"
import type { DeclarationOptions } from "./options"

interface OperationEntryLayout {
  params?: ContractField[]
  bodyKey: "body" | "payload"
  responseKey: "response" | "reply"
}

export function renderOperationEntry(
  operation: ContractOperation,
  layout: OperationEntryLayout,
  options: DeclarationOptions,
): string {
  const lines: string[] = []
  if (layout.params) {
    lines.push(`    params: ${indentContinuation(renderParam(layout.params, options), "    ")}`)
  }
  lines.push(`    query: ${indentContinuation(renderParam(operation.query, options), "    ")}`)
  if (options.headers) {
    lines.push(
      `    headers: ${indentContinuation(renderParam(operation.headers, options), "    ")}`,
    )
  }
  lines.push(`    ${renderBody(operation.body, layout.bodyKey, options)}`)
  lines.push(
    `    ${layout.responseKey}: ${indentContinuation(renderResponseMap(operation.responses, options), "    ")}`,
  )
  return `${entryDocHeader(operation)}  ${safeKey(operation.key)}: {\n${lines.join("\n")}\n  }`
}
