/** Failure while building the contract IR from a prepared OpenAPI document. */
export class BuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "BuildError"
  }
}
