import type { DiagnosticCode, Diagnostics } from "./diagnostics"
import type { DocumentNode, DocumentSet } from "./documents"
import type { GenerationControl } from "./generation-control"
import { appendPointer } from "./json-pointer"

/**
 * What every build step reads from and reports to: the description's documents, and its
 * diagnostics, located at the node they concern.
 */
export class BuildContext {
  constructor(
    readonly documents: DocumentSet,
    readonly diagnostics: Diagnostics,
    readonly control: GenerationControl,
  ) {}

  /** A warning at a node, or at one of its keys. */
  warn(code: DiagnosticCode, message: string, node: DocumentNode, key?: string): void {
    this.diagnostics.warn(code, message, this.locate(node, key))
  }

  /** An error at a node, or at one of its keys. */
  error(code: DiagnosticCode, message: string, node: DocumentNode, key?: string): void {
    this.diagnostics.error(code, message, this.locate(node, key))
  }

  private locate(node: DocumentNode, key: string | undefined): string {
    const pointer = key === undefined ? node.pointer : appendPointer(node.pointer, key)
    return this.documents.locate(node.document, pointer)
  }
}
