export interface DeclarationOptions {
  /** Emit an `errors` field per entry, keyed by status code. For endpoints these are received error responses; for webhooks they are error replies the handler returns. */
  errors?: boolean;
  /** Emit a typed `headers` field per entry from `in: header` parameters. For endpoints these are headers the client sends; for webhooks they are headers the third party sends. */
  headers?: boolean;
  /** Map OpenAPI `format` values to TypeScript type expressions, e.g. `{ "date-time": "Date", uuid: "string" }`. User mappings override built-ins (e.g. `binary` → `Blob`). */
  formats?: Record<string, string>;
}
