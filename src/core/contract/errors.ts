export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadError";
  }
}

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}
