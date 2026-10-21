/**
 * Stable identifiers for everything the generator reports.
 *
 * Errors stop generation because the output would be wrong. Warnings mark what someone can act on:
 * a part of the document the output cannot apply, or one that is not valid. Where a document's
 * evident intent departs from the letter of its version, the output follows the intent without a
 * warning, as docs/openapi.md describes.
 */
export type DiagnosticCode =
  // errors
  | "invalid-document"
  | "unsupported-version"
  | "read-failed"
  | "unresolved-ref"
  | "circular-ref"
  // warnings: something the output cannot apply
  | "ignored-field"
  | "circular-schema"
  | "discriminator-mismatch"
  | "renamed-schema"
  | "schema-precision-loss"
  | "unsupported-request-encoding"
  // warnings: something not valid
  | "invalid-schema"
  | "invalid-parameter"
  | "path-parameter-mismatch"
  | "invalid-status-code"
  | "path-item-conflict"

export interface Diagnostic {
  severity: "error" | "warning"
  code: DiagnosticCode
  message: string
  /**
   * Where the problem is: `#/json/pointer` inside the entry document, or
   * `<absolute-uri>#/json/pointer` inside another document.
   */
  location: string
}

export class Diagnostics {
  readonly list: Diagnostic[] = []
  private readonly seen = new Set<string>()

  error(code: DiagnosticCode, message: string, location: string): void {
    this.add({ severity: "error", code, message, location })
  }

  warn(code: DiagnosticCode, message: string, location: string): void {
    this.add({ severity: "warning", code, message, location })
  }

  get hasErrors(): boolean {
    return this.list.some((d) => d.severity === "error")
  }

  private add(diagnostic: Diagnostic): void {
    // The same schema can be visited from several places; report it once.
    const key = `${diagnostic.code}\0${diagnostic.location}\0${diagnostic.message}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.list.push(diagnostic)
  }
}
