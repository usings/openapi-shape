import { describe, expect, it } from "vitest";
import { safeIdentifier, safeKey } from "../src/naming";

describe("safeIdentifier", () => {
  it("passes a valid identifier through", () => {
    expect(safeIdentifier("User")).toBe("User");
  });
  it("replaces invalid chars with _", () => {
    expect(safeIdentifier("User-Profile")).toBe("User_Profile");
  });
  it("prefixes _ when starting with a digit", () => {
    expect(safeIdentifier("3D")).toBe("_3D");
  });
  it("prefixes _ when name is a TS reserved word", () => {
    expect(safeIdentifier("class")).toBe("_class");
    expect(safeIdentifier("interface")).toBe("_interface");
  });
  it("falls back to _ when name is empty", () => {
    expect(safeIdentifier("")).toBe("_");
  });
});

describe("safeKey", () => {
  it("returns the name unquoted when valid", () => {
    expect(safeKey("name")).toBe("name");
  });
  it("returns JSON-quoted when invalid", () => {
    expect(safeKey("user-id")).toBe('"user-id"');
    expect(safeKey("0abc")).toBe('"0abc"');
  });
});
