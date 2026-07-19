export class LoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "LoadError"
  }
}

export class BuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "BuildError"
  }
}
