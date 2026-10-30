/** Library-owned client failures, discriminated by their stable code. */
export type ClientDiagnostic =
  | { readonly code: "HTTP_ERROR"; readonly details: { readonly response: Response } }
  | { readonly code: "UNDECLARED_STATUS"; readonly details: { readonly response: Response } }
  | {
      readonly code: "UNEXPECTED_MEDIA_TYPE"
      readonly details: {
        readonly response: Response
        readonly expected: readonly string[]
        readonly actual: string | undefined
      }
    }
  | { readonly code: "INVALID_RESPONSE_BODY"; readonly details: { readonly response: Response } }
  | {
      readonly code: "INVALID_STREAM_RECORD"
      readonly details: { readonly line: number }
    }
  | {
      readonly code: "MESSAGE_TOO_LARGE"
      readonly details: { readonly maxMessageBytes: number; readonly receivedBytes: number }
    }

/** One Error identity with code-specific diagnostic details. Native failures pass through unchanged. */
export type ClientError = Error & ClientDiagnostic

/** The constructor accepts a complete union member so code and details cannot drift apart. */
export const ClientError = class extends Error {
  readonly code: ClientDiagnostic["code"]
  readonly details: ClientDiagnostic["details"]

  constructor(message: string, diagnostic: ClientDiagnostic, options?: ErrorOptions) {
    super(message, options)
    this.name = "ClientError"
    this.code = diagnostic.code
    this.details = diagnostic.details
  }
  // Both fields come from one union member; the public instance type preserves that correlation.
} as {
  new (message: string, diagnostic: ClientDiagnostic, options?: ErrorOptions): ClientError
  readonly prototype: ClientError
}
