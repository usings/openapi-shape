export class LoadError extends Error {
  public source?: string;
  constructor(message: string, source?: string) {
    super(message);
    this.name = "LoadError";
    this.source = source;
  }
}

export class BuildError extends Error {
  public location: string;
  constructor(message: string, location: string) {
    super(message);
    this.name = "BuildError";
    this.location = location;
  }
}
