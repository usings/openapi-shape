import { describe, expect, it } from "vitest";
import {
  indent,
  indentContinuation,
  interfaceDecl,
  typeDecl,
  jsdoc,
  safeKey,
  safeIdentifier,
} from "../src/helpers";

describe("helpers", () => {
  describe("indent", () => {
    it("indents a single line by 2 spaces", () => {
      expect(indent("foo: string")).toBe("  foo: string");
    });

    it("indents multiple lines", () => {
      expect(indent("a\nb")).toBe("  a\n  b");
    });

    it("indents by custom depth", () => {
      expect(indent("x", 2)).toBe("    x");
    });
  });

  describe("jsdoc", () => {
    it("returns empty string when no fields are set", () => {
      expect(jsdoc({})).toBe("");
    });

    it("emits single-line block for one-line description", () => {
      expect(jsdoc({ description: "A pet" })).toBe("/** A pet */\n");
    });

    it("emits multi-line block for multi-line description", () => {
      expect(jsdoc({ description: "line one\nline two" })).toBe(
        "/**\n * line one\n * line two\n */\n",
      );
    });

    it("combines summary, description, and @deprecated", () => {
      const result = jsdoc({ summary: "short", description: "long", deprecated: true });
      expect(result).toBe("/**\n * short\n *\n * long\n *\n * @deprecated\n */\n");
    });

    it("emits @deprecated alone when no description", () => {
      expect(jsdoc({ deprecated: true })).toBe("/** @deprecated */\n");
    });

    it("applies indent prefix to every line", () => {
      expect(jsdoc({ description: "a\nb" }, "  ")).toBe("  /**\n   * a\n   * b\n   */\n");
    });

    it("trims trailing whitespace from description", () => {
      expect(jsdoc({ description: "  hello  " })).toBe("/** hello */\n");
    });
  });

  describe("indentContinuation", () => {
    it("returns single-line text unchanged", () => {
      expect(indentContinuation("foo", "    ")).toBe("foo");
    });

    it("leaves first line unindented and prefixes subsequent lines", () => {
      expect(indentContinuation("a\nb\nc", "  ")).toBe("a\n  b\n  c");
    });

    it("supports arbitrary prefix strings", () => {
      expect(indentContinuation("x\ny", ">>")).toBe("x\n>>y");
    });
  });

  describe("interfaceDecl", () => {
    it("generates an exported interface", () => {
      expect(interfaceDecl("Foo", "bar: string\nbaz: number")).toBe(
        "export interface Foo {\n  bar: string\n  baz: number\n}",
      );
    });
  });

  describe("typeDecl", () => {
    it("generates an exported type alias", () => {
      expect(typeDecl("Status", '"active" | "inactive"')).toBe(
        'export type Status = "active" | "inactive"',
      );
    });
  });

  describe("safeKey", () => {
    it("returns a valid identifier unchanged", () => {
      expect(safeKey("foo")).toBe("foo");
      expect(safeKey("_x")).toBe("_x");
      expect(safeKey("$id")).toBe("$id");
      expect(safeKey("a1")).toBe("a1");
    });

    it("treats TS reserved words as valid property keys", () => {
      expect(safeKey("class")).toBe("class");
      expect(safeKey("default")).toBe("default");
    });

    it("quotes names with illegal characters", () => {
      expect(safeKey("user-id")).toBe('"user-id"');
      expect(safeKey("foo.bar")).toBe('"foo.bar"');
      expect(safeKey("with space")).toBe('"with space"');
    });

    it("quotes names starting with a digit", () => {
      expect(safeKey("123")).toBe('"123"');
    });
  });

  describe("safeIdentifier", () => {
    it("returns a valid identifier unchanged", () => {
      expect(safeIdentifier("Foo")).toBe("Foo");
      expect(safeIdentifier("_x")).toBe("_x");
      expect(safeIdentifier("$id")).toBe("$id");
    });

    it("replaces illegal characters with underscore", () => {
      expect(safeIdentifier("User-Profile")).toBe("User_Profile");
      expect(safeIdentifier("v1.UserProfile")).toBe("v1_UserProfile");
      expect(safeIdentifier("foo bar baz")).toBe("foo_bar_baz");
    });

    it("prefixes underscore when starting with a digit", () => {
      expect(safeIdentifier("123Foo")).toBe("_123Foo");
      expect(safeIdentifier("1.2.3")).toBe("_1_2_3");
    });
  });
});
