import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import type * as Citty from "citty"
import type { CommandDef } from "citty"
import { renderUsage, runCommand, runMain } from "citty"
import { afterEach, describe, expect, it, vi } from "vitest"
import { oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"

// Importing the bin hands its command to runMain; capture it instead of running it.
vi.mock("citty", async (importOriginal) => ({
  ...(await importOriginal<typeof Citty>()),
  runMain: vi.fn<typeof runMain>(),
}))
await import("../src/cli")
const command = vi.mocked(runMain).mock.calls[0][0] as CommandDef

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

/** Run the command as `openapi-shape …argv` from `cwd`, capturing its output. */
async function run(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ""
  let stderr = ""
  vi.spyOn(process, "cwd").mockReturnValue(cwd)
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  try {
    await runCommand(command, { rawArgs: argv })
  } finally {
    vi.restoreAllMocks()
  }
  const code = Number(process.exitCode ?? 0)
  process.exitCode = undefined
  return { code, stdout, stderr: stripVTControlCharacters(stderr) }
}

const spec = oas("3.1", {
  components: {
    schemas: {
      When: { type: "string", format: "date-time" },
      Id: { type: "integer", format: "int64" },
    },
  },
})

describe("openapi-shape <source>", () => {
  it("prints to stdout by default, resolving paths against the working directory", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      const result = await run(["openapi.json"], dir)
      expect(result).toMatchObject({ code: 0, stderr: "" })
      expect(result.stdout).toContain("export type When = string")
    })
  })

  it("writes --output, creating directories, with --formats mappings", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      const result = await run(
        [
          "openapi.json",
          "-o",
          "src/gen/api.ts",
          "--formats",
          "date-time=Date, int64=Map<string, number>",
        ],
        dir,
      )
      expect(result).toMatchObject({ code: 0, stdout: "", stderr: "✔ Wrote src/gen/api.ts\n" })
      const code = await readFile(join(dir, "src/gen/api.ts"), "utf8")
      expect(code).toContain("export type When = Date")
      expect(code).toContain("export type Id = Map<string, number>")
    })
  })

  it("merges repeated --formats", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      // citty drops `--no-*` flags before it reads values.
      const argv = [
        "openapi.json",
        "--formats",
        "--no-check",
        "date-time=Date",
        "--formats=int64=bigint",
      ]
      const result = await run(argv, dir)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("export type When = Date")
      expect(result.stdout).toContain("export type Id = bigint")
    })
  })

  it("writes declarations only to .d.ts files", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      await run(["openapi.json", "-o", "api.ts"], dir)
      await run(["openapi.json", "-o", "api.d.ts"], dir)
      await run(["openapi.json", "-o", "API.D.MTS"], dir)
      expect(await readFile(join(dir, "api.ts"), "utf8")).toContain("export const contract")
      expect(await readFile(join(dir, "api.d.ts"), "utf8")).not.toContain("contract")
      expect(await readFile(join(dir, "API.D.MTS"), "utf8")).not.toContain("contract")
    })
  })

  it("only writes TypeScript", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      const result = await run(["openapi.json", "-o", "api.js"], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("--output must be a .ts, .mts, or .cts file, got api.js")
    })
  })

  it("reports an output it cannot write", async () => {
    await withFiles({ "openapi.json": spec, "file": "" }, async (dir) => {
      const result = await run(["openapi.json", "-o", "file/api.ts"], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error Cannot write file\/api\.ts: /m)
    })
  })

  it("checks --output without writing", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      const missing = await run(["openapi.json", "-o", "api.d.ts", "--check"], dir)
      expect(missing).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("api.d.ts does not exist"),
      })
      await run(["openapi.json", "-o", "api.d.ts"], dir)
      const fresh = await run(["openapi.json", "-o", "api.d.ts", "--check"], dir)
      expect(fresh).toMatchObject({ code: 0, stderr: "✔ api.d.ts is up to date\n" })
      const stale = await run(
        ["openapi.json", "-o", "api.d.ts", "--check", "--formats", "date-time=Date"],
        dir,
      )
      expect(stale.code).toBe(1)
      expect(stale.stderr).toContain("api.d.ts is out of date")
      expect(stale.stderr).toContain(
        "expected:   export type When = Date\n    found:      export type When = string",
      )
      expect(await readFile(join(dir, "api.d.ts"), "utf8")).toContain("When = string")
    })
  })

  it("reports warnings grouped by code", async () => {
    const schemas = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `S${i}`,
        { type: "string", nullable: true, enum: ["a"] },
      ]),
    )
    await withFiles({ "openapi.json": oas("3.0", { components: { schemas } }) }, async (dir) => {
      const result = await run(["openapi.json", "-o", "api.d.ts"], dir)
      expect(result.code).toBe(0)
      expect(result.stderr.match(/^warning lenient-nullable/gm)).toHaveLength(3)
      expect(result.stderr).toContain("    at #/components/schemas/S0/nullable\n")
      expect(result.stderr).toContain("  … and 2 more lenient-nullable warnings\n")
      expect(result.stderr).toContain("✔ Wrote api.d.ts with 5 warnings")
    })
  })

  it("exits 1 with every error when generation fails", async () => {
    const broken = oas("3.1", {
      components: { schemas: { A: { $ref: "#/x" }, B: { $ref: "other.json" } } },
    })
    await withFiles({ "openapi.json": broken }, async (dir) => {
      const result = await run(["openapi.json", "-o", "api.d.ts"], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('error unresolved-ref: Cannot resolve $ref "#/x"')
      expect(result.stderr).toContain('error unresolved-ref: Cannot resolve $ref "other.json"')
    })
  })

  it.each([
    [["a", "b"], "Expected one <source>, got a, b"],
    [["a", "--check"], "--check requires --output"],
    [["a", "--formats", "nope"], '--formats expects name=type pairs, got "nope"'],
    [["a", "--chek"], "Unknown option --chek"],
    [["a", "-o", "x.ts", "--output=y.ts"], "--output can be given only once"],
    [["a", "-ox.ts", "-o", "y.ts"], "--output can be given only once"],
    [["a", "--o", "x.ts", "--o=y.ts"], "--output can be given only once"],
  ])("rejects %j with usage", async (argv, message) => {
    const result = await run(argv, ".")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`error ${message}`)
    expect(result.stderr).toContain("USAGE")
  })

  it("describes itself", async () => {
    const usage = stripVTControlCharacters(await renderUsage(command))
    expect(usage).toContain(
      "Generate a TypeScript module (types and the client contract) from an OpenAPI 3.0, 3.1, or 3.2 description.",
    )
    expect(usage).toContain("--formats")
  })
})
