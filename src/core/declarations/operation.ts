import type { ContractField, ContractOperation } from "../contract/model"
import { safeKey } from "../shared/naming"
import { entryDocHeader, renderBody, renderParam, renderResponseMap } from "./entry"
import { indentContinuation } from "./format"
import type { DeclarationOptions } from "./options"
import type { RenderTypeOptions } from "./render-type"

interface OperationEntryLayout {
  params?: ContractField[]
  bodyKey: "body" | "payload"
  responseKey: "response" | "reply"
}

/** Wrap rendered operation entries in an exported interface declaration. */
export function renderOperationsInterface(name: string, entries: string[]): string {
  return `export interface ${name} {\n${entries.join("\n")}\n}`
}

function entryField(key: string, text: string): string {
  return `    ${key}: ${indentContinuation(text, "    ")}`
}

export function renderOperationEntry(
  operation: ContractOperation,
  layout: OperationEntryLayout,
  options: DeclarationOptions,
): string {
  // Operation entries always reference schemas through the Schemas namespace.
  const renderOptions: RenderTypeOptions = { formats: options.formats, refPrefix: "Schemas." }
  const lines: string[] = []
  if (layout.params) {
    lines.push(entryField("params", renderParam(layout.params, renderOptions)))
  }
  lines.push(entryField("query", renderParam(operation.query, renderOptions)))
  if (options.headers) {
    lines.push(entryField("headers", renderParam(operation.headers, renderOptions)))
  }
  if (options.cookies) {
    lines.push(entryField("cookies", renderParam(operation.cookies, renderOptions)))
  }
  lines.push(`    ${renderBody(operation.body, layout.bodyKey, renderOptions)}`)
  lines.push(entryField(layout.responseKey, renderResponseMap(operation.responses, renderOptions)))
  return `${entryDocHeader(operation)}  ${safeKey(operation.key)}: {\n${lines.join("\n")}\n  }`
}
