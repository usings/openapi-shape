import { describe, expect, it } from "vitest";
import { LoadError, BuildError } from "../../../src/core/shared/errors";

describe("LoadError", () => {
  it("captures source", () => {
    const err = new LoadError("could not read", "./x.json");
    expect(err.message).toBe("could not read");
    expect(err.source).toBe("./x.json");
    expect(err).toBeInstanceOf(Error);
  });
  it("source is optional", () => {
    expect(new LoadError("bad").source).toBeUndefined();
  });
});

describe("BuildError", () => {
  it("captures location", () => {
    const err = new BuildError("collision", "/components/schemas/User");
    expect(err.location).toBe("/components/schemas/User");
    expect(err).toBeInstanceOf(Error);
  });
});
