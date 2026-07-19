export interface DeclarationOptions {
  /**
   * Emit typed `in: header` parameters for endpoints, webhooks, and callbacks.
   */
  headers?: boolean
  /**
   * Map OpenAPI formats to TypeScript expressions. User mappings override
   * built-ins such as `binary` → `Blob`.
   */
  formats?: Record<string, string>
}
