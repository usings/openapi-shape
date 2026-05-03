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
  it("renders single-line summary inline with @summary tag", () => {
    expect(jsdoc({ summary: "hi" })).toBe("/** @summary hi */\n");
  });
  it("renders summary and description with tags", () => {
    expect(jsdoc({ summary: "a", description: "b" })).toBe(
      "/**\n * @summary a\n * @description b\n */\n",
    );
  });
  it("renders standalone description with @description tag", () => {
    expect(jsdoc({ description: "hi" })).toBe("/** @description hi */\n");
  });
  it("preserves description multi-line continuation", () => {
    expect(jsdoc({ description: "a\nb" })).toBe("/**\n * @description a\n * b\n */\n");
  });
  it("appends @deprecated tag", () => {
    expect(jsdoc({ deprecated: true })).toBe("/** @deprecated */\n");
  });
  it("supports indent prefix", () => {
    expect(jsdoc({ summary: "hi" }, "  ")).toBe("  /** @summary hi */\n");
  });
  it("escapes comment terminators", () => {
    expect(jsdoc({ summary: "a */ b" })).toBe("/** @summary a *\\/ b */\n");
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
