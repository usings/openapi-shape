/** Failure while reading, parsing, or preparing an OpenAPI document. */
export class LoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "LoadError"
  }
}
