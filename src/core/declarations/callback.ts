import type { CallbackOperation } from "../contract/model"
import { renderOperationEntry, renderOperationsInterface } from "./operation"
import type { DeclarationOptions } from "./options"

export function renderCallbacksInterface(
  callbacks: CallbackOperation[],
  options: DeclarationOptions = {},
): string {
  return renderOperationsInterface(
    "Callbacks",
    callbacks.map((callback) => renderCallbackEntry(callback, options)),
  )
}

function renderCallbackEntry(callback: CallbackOperation, options: DeclarationOptions): string {
  return renderOperationEntry(
    callback,
    { params: callback.params, bodyKey: "payload", responseKey: "reply" },
    options,
  )
}
