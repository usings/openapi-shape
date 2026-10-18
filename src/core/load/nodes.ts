import { parsePointer } from "../shared/pointer"
import type { DocumentNode } from "./documents"

/** Canonical identity of a node: retrieval URI plus JSON Pointer. */
export function identity(node: DocumentNode): string {
  return `${node.document.uri}#${node.pointer}`
}

/** The `components.schemas` key a node is declared under, in any document. */
export function componentNameOf(node: DocumentNode): string | undefined {
  const tokens = parsePointer(node.pointer)
  if (tokens?.length === 3 && tokens[0] === "components" && tokens[1] === "schemas") {
    return tokens[2]
  }
  return undefined
}
