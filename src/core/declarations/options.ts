export interface DeclarationOptions {
  /**
   * Emit typed `in: header` parameters: outgoing headers for endpoints and
   * incoming headers for webhooks.
   */
  headers?: boolean
  /**
   * Map OpenAPI formats to TypeScript expressions. User mappings override
   * built-ins such as `binary` → `Blob`.
   */
  formats?: Record<string, string>
}
