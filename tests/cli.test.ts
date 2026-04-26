import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const fixture = join(import.meta.dirname, "fixtures/petstore.json");

describe("runCli", () => {
  const tmpFiles: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpFiles.splice(0).map((f) => unlink(f).catch(() => {})));
  });

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
    expect(stdout).toContain("export interface API");
    expect(stdout).toContain("export interface Pet");
  });

  it("writes generated code to file when -o is given", async () => {
    const out = "/tmp/openapi-shape-cli-test.ts";
    tmpFiles.push(out);
    const { exitCode, stdout } = await runCli([fixture, "-o", out]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`Generated ${out}\n`);
    const written = await readFile(out, "utf-8");
    expect(written).toContain("export interface API");
  });

  it("rejects when -o has no value", async () => {
    await expect(runCli([fixture, "-o"])).rejects.toThrow();
  });

  it("rejects when source file does not exist", async () => {
    await expect(runCli(["/tmp/openapi-shape-does-not-exist.json"])).rejects.toThrow();
  });
});
