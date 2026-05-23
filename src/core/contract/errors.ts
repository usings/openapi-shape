/** Error raised while reading, parsing, normalizing, or preparing an OpenAPI document. */
export class LoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LoadError"
  }
}

/** Error raised after preparation, while converting a document into the contract IR. */
export class BuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BuildError"
  }
}
