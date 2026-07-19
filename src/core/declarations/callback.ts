import type { CallbackOperation } from "../contract/contract"
import { renderOperationEntry } from "./operation"
import type { DeclarationOptions } from "./options"

export function renderCallbacksInterface(
  callbacks: CallbackOperation[],
  options: DeclarationOptions = {},
): string {
  const entries = callbacks.map((callback) => renderCallbackEntry(callback, options))
  return `export interface Callbacks {\n${entries.join("\n")}\n}`
}

function renderCallbackEntry(callback: CallbackOperation, options: DeclarationOptions): string {
  return renderOperationEntry(callback, { bodyKey: "payload", responseKey: "reply" }, options)
}
