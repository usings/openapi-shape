import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTmpPath, withTmpFile } from "./_helpers/tmp";

const fixture = join(import.meta.dirname, "fixtures/petstore.json");

describe("runCli", () => {
  it("prints help and exits 1 when no positional given", async () => {
    const { exitCode, stdout } = await runCli([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage: openapi-shape");
  });

  it("prints help and exits 0 when --help given", async () => {
    const { exitCode, stdout } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: openapi-shape");
  });

  it("prints help and exits 0 with -h short flag", async () => {
    const { exitCode, stdout } = await runCli(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: openapi-shape");
  });

  it("writes generated code to stdout when -o is omitted", async () => {
    const { exitCode, stdout } = await runCli([fixture]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("export interface Endpoints");
    expect(stdout).toContain("export interface Pet");
  });

  it("writes generated code to file when -o is given", async () => {
    await withTmpPath(
      async (out) => {
        const { exitCode, stdout } = await runCli([fixture, "-o", out]);
        expect(exitCode).toBe(0);
        expect(stdout).toBe(`Generated ${out}\n`);
        const written = await readFile(out, "utf-8");
        expect(written).toContain("export interface Endpoints");
      },
      { ext: ".ts" },
    );
  });

  it("rejects when -o has no value", async () => {
    await expect(runCli([fixture, "-o"])).rejects.toThrow();
  });

  it("rejects when source file does not exist", async () => {
    await expect(runCli(["/tmp/openapi-shape-does-not-exist.json"])).rejects.toThrow();
  });

  it("--check: exits 0 when output file matches generated code", async () => {
    const { stdout: generated } = await runCli([fixture]);
    await withTmpFile(
      generated,
      async (out) => {
        const { exitCode, stdout } = await runCli([fixture, "-o", out, "--check"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("up to date");
      },
      { ext: ".ts" },
    );
  });

  it("--check: exits 1 when output file differs from generated code", async () => {
    await withTmpFile(
      "// stale content\n",
      async (out) => {
        const { exitCode, stdout } = await runCli([fixture, "-o", out, "--check"]);
        expect(exitCode).toBe(1);
        expect(stdout).toContain("out of date");
        expect(stdout).toContain(out);
      },
      { ext: ".ts" },
    );
  });

  it("--check: exits 1 when output file does not exist", async () => {
    await withTmpPath(
      async (out) => {
        const { exitCode, stdout } = await runCli([fixture, "-o", out, "--check"]);
        expect(exitCode).toBe(1);
        expect(stdout).toContain("out of date");
      },
      { ext: ".ts" },
    );
  });

  it("--check: errors when -o is omitted", async () => {
    const { exitCode, stdout } = await runCli([fixture, "--check"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("--check requires --output");
  });

  it("--check: does not modify the output file", async () => {
    const before = "// stale content\n";
    await withTmpFile(
      before,
      async (out) => {
        await runCli([fixture, "-o", out, "--check"]);
        const after = await readFile(out, "utf-8");
        expect(after).toBe(before);
      },
      { ext: ".ts" },
    );
  });
});
