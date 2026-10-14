/**
 * Stable identifiers for everything the generator reports.
 *
 * Errors stop generation because the output would be wrong. Warnings mark
 * where the output and the letter of the specification part ways: `lenient-*`
 * where the document's evident intent (what the real API does) is followed
 * instead, the others where something is ignored or approximated.
 */
export type DiagnosticCode =
  // errors
  | "invalid-document"
  | "unsupported-version"
  | "read-failed"
  | "unresolved-ref"
  | "circular-ref"
  // warnings: the document's intent is followed where its version says otherwise
  | "lenient-nullable"
  | "lenient-request-body"
  | "lenient-format"
  | "lenient-ref-siblings"
  | "lenient-keyword"
  | "lenient-read-only"
  | "lenient-security"
  // warnings: something is ignored, approximated, or invalid
  | "ignored-keyword"
  | "invalid-schema"
  | "unknown-dialect"
  | "dynamic-ref"
  | "circular-schema"
  | "discriminator-mismatch"
  | "invalid-parameter"
  | "invalid-security"
  | "invalid-server"
  | "path-parameter-mismatch"
  | "invalid-status-code"
  | "path-item-conflict"
  | "renamed-schema"

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
