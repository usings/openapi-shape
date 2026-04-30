import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { readFile, writeFile, unlink } from "node:fs/promises";
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
    expect(stdout).toContain("export interface Endpoints");
    expect(stdout).toContain("export interface Pet");
  });

  it("writes generated code to file when -o is given", async () => {
    const out = "/tmp/openapi-shape-cli-test.ts";
    tmpFiles.push(out);
    const { exitCode, stdout } = await runCli([fixture, "-o", out]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`Generated ${out}\n`);
    const written = await readFile(out, "utf-8");
    expect(written).toContain("export interface Endpoints");
  });

  it("rejects when -o has no value", async () => {
    await expect(runCli([fixture, "-o"])).rejects.toThrow();
  });

  it("rejects when source file does not exist", async () => {
    await expect(runCli(["/tmp/openapi-shape-does-not-exist.json"])).rejects.toThrow();
  });
});

// Append at end of tests/cli.test.ts
describe("cli new flags", () => {
  it("--errors emits without crashing", async () => {
    const fixturePath = join(import.meta.dirname, "fixtures/petstore.json");
    const r = await runCli([fixturePath, "--errors"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("--no-header omits the JSDoc header", async () => {
    const fixturePath = join(import.meta.dirname, "fixtures/petstore.json");
    const r = await runCli([fixturePath, "--no-header"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith("/**\n")).toBe(false);
  });

  it("--endpoint-key=operation-id uses operationId for keys", async () => {
    const path = `/tmp/openapi-shape-cli-${Date.now()}.json`;
    await writeFile(
      path,
      JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: {
                "200": { content: { "application/json": { schema: { type: "string" } } } },
              },
            },
          },
        },
      }),
    );
    try {
      const r = await runCli([path, "--endpoint-key=operation-id"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('"listPets":');
      expect(r.stdout).not.toContain('"GET /pets"');
    } finally {
      await unlink(path);
    }
  });

  it("--endpoint-key=method-path is the explicit default", async () => {
    const path = `/tmp/openapi-shape-cli-${Date.now()}.json`;
    await writeFile(
      path,
      JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: {
                "200": { content: { "application/json": { schema: { type: "string" } } } },
              },
            },
          },
        },
      }),
    );
    try {
      const r = await runCli([path, "--endpoint-key=method-path"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('"GET /pets":');
    } finally {
      await unlink(path);
    }
  });

  it("rejects --endpoint-key with invalid value", async () => {
    const fixturePath = join(import.meta.dirname, "fixtures/petstore.json");
    const r = await runCli([fixturePath, "--endpoint-key=garbage"]);
    expect(r.exitCode).toBe(1);
  });
});
