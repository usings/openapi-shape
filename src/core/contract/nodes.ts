import type { Node } from "../openapi/documents"
import { parsePointer } from "../shared/pointer"

/** Canonical identity of a node: retrieval URI plus JSON Pointer. */
export function identity(node: Node): string {
  return `${node.doc.uri}#${node.pointer}`
}

/** The `components.schemas` key a node is declared under, in any document. */
export function componentNameOf(node: Node): string | undefined {
  const tokens = parsePointer(node.pointer)
  if (tokens?.length === 3 && tokens[0] === "components" && tokens[1] === "schemas") {
    return tokens[2]
  }
  return undefined
}
