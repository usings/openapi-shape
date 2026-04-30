import { describe, expect, it } from "vitest";
import {
  indent,
  jsdoc,
  indentContinuation,
  interfaceDecl,
  typeDecl,
} from "../../src/render/format";

describe("indent", () => {
  it("indents each line by depth*2 spaces", () => {
    expect(indent("a\nb")).toBe("  a\n  b");
    expect(indent("a", 2)).toBe("    a");
  });
});

describe("jsdoc", () => {
  it("returns empty string when nothing to document", () => {
    expect(jsdoc({})).toBe("");
  });
  it("renders single-line summary inline", () => {
    expect(jsdoc({ summary: "hi" })).toBe("/** hi */\n");
  });
  it("renders multi-line", () => {
    expect(jsdoc({ summary: "a", description: "b" })).toBe("/**\n * a\n *\n * b\n */\n");
  });
  it("appends @deprecated tag", () => {
    expect(jsdoc({ deprecated: true })).toBe("/** @deprecated */\n");
  });
  it("supports indent prefix", () => {
    expect(jsdoc({ summary: "hi" }, "  ")).toBe("  /** hi */\n");
  });
});

describe("indentContinuation", () => {
  it("indents lines after the first", () => {
    expect(indentContinuation("a\nb\nc", "    ")).toBe("a\n    b\n    c");
  });
  it("returns single line unchanged", () => {
    expect(indentContinuation("a", "    ")).toBe("a");
  });
});

describe("interfaceDecl", () => {
  it("wraps body with export interface block", () => {
    expect(interfaceDecl("X", "a: number")).toBe("export interface X {\n  a: number\n}");
  });
});

describe("typeDecl", () => {
  it("emits export type alias", () => {
    expect(typeDecl("X", "string")).toBe("export type X = string");
  });
});
