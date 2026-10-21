import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { renderUsage, runCommand } from "citty"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cli } from "../src/cli/command"
import { oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"

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
    await runCommand(cli, { rawArgs: argv })
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

  it("writes --output, creating directories", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      const result = await run(["openapi.json", "-o", "src/gen/api.ts"], dir)
      expect(result).toMatchObject({ code: 0, stdout: "", stderr: "Wrote src/gen/api.ts\n" })
      const code = await readFile(join(dir, "src/gen/api.ts"), "utf8")
      expect(code).toContain("export type When = string")
      expect(code).toContain("export const contract")
    })
  })

  it("writes only an ES module, not CommonJS or a declaration file", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      for (const output of ["api.js", "api.cts", "api.d.ts", "API.D.MTS", "api.d.json.ts"]) {
        // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
        const result = await run(["openapi.json", "-o", output], dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain(`--output must be a .ts or .mts module, got ${output}`)
      }
      await expect(readFile(join(dir, "api.d.ts"), "utf8")).rejects.toThrow("ENOENT")
      expect(await run(["openapi.json", "-o", "api.mts"], dir)).toMatchObject({ code: 0 })
    })
  })

  it("reports an output it cannot write", async () => {
    await withFiles({ "openapi.json": spec, "file": "" }, async (dir) => {
      const result = await run(["openapi.json", "-o", "file/api.ts"], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/^error: Cannot write file\/api\.ts: .*\n$/)
    })
  })

  it("checks --output without writing", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      const missing = await run(["openapi.json", "-o", "api.ts", "--check"], dir)
      expect(missing).toMatchObject({
        code: 1,
        stderr: "error: api.ts does not exist; run the same command without --check to write it\n",
      })
      await run(["openapi.json", "-o", "api.ts"], dir)
      const fresh = await run(["openapi.json", "-o", "api.ts", "--check"], dir)
      expect(fresh).toMatchObject({ code: 0, stderr: "api.ts is up to date\n" })
      const written = await readFile(join(dir, "api.ts"), "utf8")
      const edited = written.replace("= string", "= Date")
      await writeFile(join(dir, "api.ts"), edited)
      const stale = await run(["openapi.json", "-o", "api.ts", "--check"], dir)
      expect(stale.code).toBe(1)
      // Where it differs, as `<file>:<line>:`, then what to do.
      expect(stale.stderr).toMatch(
        /^api\.ts:(\d+): expected: {3}export type When = string\napi\.ts:\1: found: {4}  export type When = Date\nerror: api\.ts is out of date; run the same command without --check to update it\n$/,
      )
      expect(await readFile(join(dir, "api.ts"), "utf8")).toBe(edited)
    })
  })

  it("reports an unreadable check target instead of treating it as missing", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      await mkdir(join(dir, "api.ts"))
      const result = await run(["openapi.json", "-o", "api.ts", "--check"], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Cannot read api.ts:")
      expect(result.stderr).not.toContain("does not exist")
    })
  })

  it("reports every diagnostic on a line of its own, located in its file, and the outcome last", async () => {
    const schemas = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`S${i}`, { type: "text" }]),
    )
    await withFiles(
      { "specs/openapi.json": oas("3.1", { components: { schemas } }) },
      async (dir) => {
        const result = await run(["./specs/openapi.json", "-o", "api.ts"], dir)
        expect(result.code).toBe(0)
        const lines = result.stderr.split("\n")
        expect(lines.slice(0, 5)).toStrictEqual(
          Array.from(
            { length: 5 },
            (_, i) =>
              `specs/openapi.json#/components/schemas/S${i}/type: warning invalid-schema: ${lines[0].split("invalid-schema: ")[1]}`,
          ),
        )
        expect(lines.slice(5)).toStrictEqual(["Wrote api.ts (5 warnings)", ""])
      },
    )
  })

  it("exits 1 with every error when generation fails", async () => {
    const broken = oas("3.1", {
      components: { schemas: { A: { $ref: "#/x" }, B: { $ref: "other.json" } } },
    })
    await withFiles({ "openapi.json": broken }, async (dir) => {
      const result = await run(["openapi.json", "-o", "api.ts"], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        'openapi.json#/components/schemas/A/$ref: error unresolved-ref: Cannot resolve $ref "#/x"',
      )
      expect(result.stderr).toContain('error unresolved-ref: Cannot resolve $ref "other.json"')
      expect(result.stderr).toMatch(/\nerror: Generation failed \(2 errors\)\n$/)
    })
  })

  it("reports a pattern timeout without replacing an existing output", async () => {
    const hostile = oas("3.1", {
      components: {
        schemas: {
          Slow: {
            type: "object",
            required: [`${"a".repeat(26)}!`],
            patternProperties: { "^(a+)+$": { type: "string" } },
          },
        },
      },
    })
    await withFiles({ "openapi.json": hostile, "api.ts": "previous output\n" }, async (dir) => {
      const result = await run(["openapi.json", "-o", "api.ts"], dir)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("error invalid-document: A patternProperties match exceeded")
      expect(await readFile(join(dir, "api.ts"), "utf8")).toBe("previous output\n")
    })
  })

  it("rejects --check without --output, pointing to --help", async () => {
    const result = await run(["a", "--check"], ".")
    expect(result).toMatchObject({
      code: 1,
      stderr: "error: --check requires --output; see openapi-shape --help\n",
    })
  })

  it("limits document size with --max-document-size, in MiB", async () => {
    const large = oas("3.1", { info: { title: "x".repeat(1024 * 1024), version: "1" } })
    await withFiles({ "openapi.json": large }, async (dir) => {
      const limited = await run(["openapi.json", "--max-document-size", "1"], dir)
      expect(limited.code).toBe(1)
      expect(limited.stderr).toContain(
        "Document is larger than 1048576 bytes; raise the limit with --max-document-size",
      )
      const raised = await run(["openapi.json", "--max-document-size=2"], dir)
      expect(raised).toMatchObject({ code: 0, stderr: "" })
    })
  })

  it.each(["0", "-1", "1.5", "1e3", "10MB", "", "9000000000"])(
    "rejects --max-document-size %j",
    async (size) => {
      const result = await run(["a", "--max-document-size", size], ".")
      expect(result).toMatchObject({
        code: 1,
        stderr: `error: --max-document-size must be a positive whole number of MiB, got "${size}"; see openapi-shape --help\n`,
      })
    },
  )

  it("requires a source", async () => {
    await expect(runCommand(cli, { rawArgs: [] })).rejects.toThrow(
      "Missing required positional argument: SOURCE",
    )
  })

  it("takes the last of a repeated option, and --no-* flags", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      const result = await run(["openapi.json", "-o", "x.ts", "-o", "y.ts", "--no-check"], dir)
      expect(result).toMatchObject({ code: 0, stderr: "Wrote y.ts\n" })
      await expect(readFile(join(dir, "x.ts"), "utf8")).rejects.toThrow("ENOENT")
    })
  })

  it("describes itself", async () => {
    const usage = stripVTControlCharacters(await renderUsage(cli))
    expect(usage).toContain(
      "Generate a TypeScript module (types and the client contract) from an OpenAPI 3.0, 3.1, or 3.2 description.",
    )
    expect(usage).toContain("--check")
    expect(usage).toContain("--max-document-size")
  })
})
