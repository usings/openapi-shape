import * as fs from "node:fs/promises"
import { chmod, lstat, mkdir, readFile, readdir, readlink, stat, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { stripVTControlCharacters } from "node:util"
import { renderUsage, runCommand } from "citty"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cli } from "../../src/cli/command"
import * as core from "../../src/core"
import { oas } from "../support/generate"
import { withFiles } from "../support/tmp"

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}))

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

  it.each(["file:/", "file:///"])("loads %s URLs with encoded paths", async (prefix) => {
    await withFiles({ "with spaces/openapi.json": spec }, async (dir) => {
      const source = pathToFileURL(join(dir, "with spaces/openapi.json")).href.replace(
        "file:///",
        prefix,
      )
      const result = await run([source], dir)
      expect(result).toMatchObject({ code: 0, stderr: "" })
      expect(result.stdout).toContain("export type When = string")
    })
  })

  it.each(["C:/spec/openapi.json", "C:\\spec\\openapi.json"])(
    "classifies Windows drive path %s as a path",
    async (source) => {
      const generate = vi.spyOn(core, "generate").mockResolvedValue({ code: "", diagnostics: [] })
      const cwd = process.cwd()
      expect(await run([source], cwd)).toMatchObject({ code: 0 })
      expect(generate).toHaveBeenCalledWith(resolve(cwd, source), { maxDocumentBytes: undefined })
    },
  )

  it("passes unsupported URI schemes to core for diagnostics", async () => {
    const result = await run(["urn:example:openapi"], process.cwd())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("urn:example:openapi")
    expect(result.stderr).not.toContain("ENOENT")
  })

  it("replaces complete output repeatedly, preserving mode and cleaning temporary files", async () => {
    await withFiles({ "openapi.json": spec, "api.ts": "previous output" }, async (dir) => {
      const target = join(dir, "api.ts")
      await chmod(target, 0o640)
      const generated = await run(["openapi.json"], dir)
      const expected = generated.stdout
      const rename = fs.rename
      const replacement = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        expect(await readFile(target, "utf8")).toBe("previous output")
        expect(await readFile(from, "utf8")).toBe(expected)
        await rename(from, to)
      })
      expect(await run(["openapi.json", "-o", "api.ts"], dir)).toMatchObject({ code: 0 })
      expect(replacement).toHaveBeenCalledOnce()
      expect(await run(["openapi.json", "-o", "api.ts"], dir)).toMatchObject({ code: 0 })
      expect(await readFile(target, "utf8")).toBe(expected)
      const info = await stat(target)
      expect(info.mode & 0o777).toBe(0o640)
      const files = await readdir(dir)
      expect(files.toSorted()).toStrictEqual(["api.ts", "openapi.json"])
    })
  })

  it.each(["partial write", "rename"])(
    "preserves old output and cleans temporary files after a %s failure",
    async (failure) => {
      await withFiles({ "openapi.json": spec, "api.ts": "previous output" }, async (dir) => {
        if (failure === "partial write") {
          const open = fs.open
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const file = await open(...args)
            const write = file.writeFile.bind(file)
            vi.spyOn(file, "writeFile").mockImplementation(async () => {
              await write("partial output")
              throw new Error("injected partial write failure")
            })
            return file
          })
        } else {
          vi.spyOn(fs, "rename").mockRejectedValue(new Error("injected rename failure"))
        }
        const result = await run(["openapi.json", "-o", "api.ts"], dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain(`Cannot write api.ts: injected ${failure} failure`)
        expect(await readFile(join(dir, "api.ts"), "utf8")).toBe("previous output")
        const files = await readdir(dir)
        expect(files.toSorted()).toStrictEqual(["api.ts", "openapi.json"])
      })
    },
  )

  it("updates a symlink's target atomically while keeping the symlink", async () => {
    await withFiles({ "openapi.json": spec, "real/api.ts": "previous output" }, async (dir) => {
      const link = join(dir, "api.ts")
      await symlink("real/api.ts", link)
      expect(await run(["openapi.json", "-o", "api.ts"], dir)).toMatchObject({ code: 0 })
      expect(await readlink(link)).toBe("real/api.ts")
      expect(await readFile(join(dir, "real/api.ts"), "utf8")).toContain(
        "export type When = string",
      )
      expect(await readdir(join(dir, "real"))).toStrictEqual(["api.ts"])
    })
  })

  it.each([
    ["relative", "existing"],
    ["absolute", "existing"],
    ["relative", "missing file"],
    ["absolute", "missing file"],
    ["relative", "missing directory"],
    ["absolute", "missing directory"],
  ])("resolves a %s output through directory symlinks before .. (%s)", async (kind, state) => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      const generated = await run(["openapi.json"], dir)
      await mkdir(join(dir, "real/nested"), { recursive: true })
      await symlink("real/nested", join(dir, "alias"))
      const actual = join(dir, "real/out/api.ts")
      const unrelated = join(dir, "out/api.ts")
      const unrelatedContents = state === "existing" ? "unrelated output" : generated.stdout
      await mkdir(dirname(unrelated))
      await fs.writeFile(unrelated, unrelatedContents)
      if (state !== "missing directory") await mkdir(dirname(actual))
      if (state === "existing") await fs.writeFile(actual, generated.stdout)
      const output = `${kind === "absolute" ? `${dir}/` : ""}alias/../out/api.ts`

      const checked = await run(["openapi.json", "-o", output, "--check"], dir)
      expect(checked.code).toBe(state === "existing" ? 0 : 1)
      expect(checked.stderr).toContain(state === "existing" ? "is up to date" : "does not exist")
      const checkedTarget = await lstat(actual).catch(() => null)
      const checkedDirectory = await lstat(dirname(actual)).catch(() => null)
      expect(checkedTarget !== null).toBe(state === "existing")
      expect(checkedDirectory !== null).toBe(state !== "missing directory")
      expect(await readFile(unrelated, "utf8")).toBe(unrelatedContents)
      expect(await run(["openapi.json", "-o", output], dir)).toMatchObject({ code: 0 })
      expect(await readFile(actual, "utf8")).toBe(generated.stdout)
      expect(await readFile(unrelated, "utf8")).toBe(unrelatedContents)
      expect(await readlink(join(dir, "alias"))).toBe("real/nested")
      expect(await readdir(dirname(actual))).toStrictEqual(["api.ts"])
      expect(await run(["openapi.json", "-o", output, "--check"], dir)).toMatchObject({ code: 0 })
    })
  })

  it.each(["relative", "absolute"])(
    "creates a %s dangling symlink's final target while preserving the link",
    async (kind) => {
      await withFiles({ "openapi.json": spec }, async (dir) => {
        const destination = kind === "relative" ? "missing.ts" : join(dir, "missing.ts")
        await symlink(destination, join(dir, "api.ts"))
        expect(await run(["openapi.json", "-o", "api.ts"], dir)).toMatchObject({ code: 0 })
        expect(await readlink(join(dir, "api.ts"))).toBe(destination)
        expect(await readFile(join(dir, "missing.ts"), "utf8")).toContain(
          "export type When = string",
        )
        const files = await readdir(dir)
        expect(files.toSorted()).toStrictEqual(["api.ts", "missing.ts", "openapi.json"])
      })
    },
  )

  it("creates the temporary file beside a dangling destination reached through an alias and ..", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      await mkdir(join(dir, "real/nested"), { recursive: true })
      await symlink("real/nested", join(dir, "alias"))
      await symlink("alias/../missing.ts", join(dir, "api.ts"))
      const directory = await fs.realpath(join(dir, "real"))
      const rename = fs.rename
      const replacement = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        expect(dirname(String(from))).toBe(directory)
        await rename(from, to)
      })
      expect(await run(["openapi.json", "-o", "api.ts"], dir)).toMatchObject({ code: 0 })
      expect(replacement).toHaveBeenCalledOnce()
      expect(await readlink(join(dir, "api.ts"))).toBe("alias/../missing.ts")
      expect(await readFile(join(dir, "real/missing.ts"), "utf8")).toContain(
        "export type When = string",
      )
      const files = await readdir(join(dir, "real"))
      expect(files.toSorted()).toStrictEqual(["missing.ts", "nested"])
    })
  })

  it("follows relative dangling link chains through directory aliases before resolving ..", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      await mkdir(join(dir, "real/nested"), { recursive: true })
      await symlink("real/nested", join(dir, "alias"))
      await symlink("alias/../next.ts", join(dir, "api.ts"))
      await symlink("nested/missing.ts", join(dir, "real/next.ts"))
      expect(await run(["openapi.json", "-o", "api.ts"], dir)).toMatchObject({ code: 0 })
      expect(await readlink(join(dir, "api.ts"))).toBe("alias/../next.ts")
      expect(await readlink(join(dir, "real/next.ts"))).toBe("nested/missing.ts")
      expect(await readFile(join(dir, "real/nested/missing.ts"), "utf8")).toContain(
        "export type When = string",
      )
      expect(await readdir(join(dir, "real/nested"))).toStrictEqual(["missing.ts"])
      await expect(lstat(join(dir, "next.ts"))).rejects.toThrow("ENOENT")
    })
  })

  it("does not create missing parent directories behind dangling symlinks", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      await symlink("missing/api.ts", join(dir, "api.ts"))
      const result = await run(["openapi.json", "-o", "api.ts"], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Cannot write api.ts:")
      expect(await readlink(join(dir, "api.ts"))).toBe("missing/api.ts")
      const files = await readdir(dir)
      expect(files.toSorted()).toStrictEqual(["api.ts", "openapi.json"])
    })
  })

  it("fails on a symlink cycle without replacing links or leaving temporary files", async () => {
    await withFiles({ "openapi.json": spec }, async (dir) => {
      await symlink("other.ts", join(dir, "api.ts"))
      await symlink("api.ts", join(dir, "other.ts"))
      const result = await run(["openapi.json", "-o", "api.ts"], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Cannot write api.ts:")
      expect(await readlink(join(dir, "api.ts"))).toBe("other.ts")
      expect(await readlink(join(dir, "other.ts"))).toBe("api.ts")
      const files = await readdir(dir)
      expect(files.toSorted()).toStrictEqual(["api.ts", "openapi.json", "other.ts"])
    })
  })

  it.skipIf(process.getuid?.() === 0)("does not replace a read-only target", async () => {
    await withFiles({ "openapi.json": spec, "api.ts": "previous output" }, async (dir) => {
      const target = join(dir, "api.ts")
      await chmod(target, 0o444)
      try {
        const result = await run(["openapi.json", "-o", "api.ts"], dir)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("Cannot write api.ts:")
        expect(await readFile(target, "utf8")).toBe("previous output")
        const files = await readdir(dir)
        expect(files.toSorted()).toStrictEqual(["api.ts", "openapi.json"])
      } finally {
        await chmod(target, 0o644)
      }
    })
  })

  it.skipIf(process.getuid?.() === 0)(
    "preserves output when its directory cannot hold a temporary file",
    async () => {
      await withFiles({ "openapi.json": spec, "out/api.ts": "previous output" }, async (dir) => {
        const outputDirectory = join(dir, "out")
        await chmod(outputDirectory, 0o555)
        try {
          const result = await run(["openapi.json", "-o", "out/api.ts"], dir)
          expect(result.code).toBe(1)
          expect(result.stderr).toContain("Cannot write out/api.ts:")
          expect(await readFile(join(outputDirectory, "api.ts"), "utf8")).toBe("previous output")
          expect(await readdir(outputDirectory)).toStrictEqual(["api.ts"])
        } finally {
          await chmod(outputDirectory, 0o755)
        }
      })
    },
  )

  it("checks current, stale, and missing output without writing", async () => {
    await withFiles({ "openapi.json": spec, "stale.ts": "previous output" }, async (dir) => {
      await run(["openapi.json", "-o", "api.ts"], dir)
      const before = await lstat(join(dir, "api.ts"))
      expect(await run(["openapi.json", "-o", "api.ts", "--check"], dir)).toMatchObject({ code: 0 })
      expect(await run(["openapi.json", "-o", "stale.ts", "--check"], dir)).toMatchObject({
        code: 1,
      })
      expect(await run(["openapi.json", "-o", "new/api.ts", "--check"], dir)).toMatchObject({
        code: 1,
      })
      const after = await lstat(join(dir, "api.ts"))
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(await readFile(join(dir, "stale.ts"), "utf8")).toBe("previous output")
      const files = await readdir(dir)
      expect(files.toSorted()).toStrictEqual(["api.ts", "openapi.json", "stale.ts"])
    })
  })

  it("checks raw bytes and reports invalid UTF-8 at the differing line without writing", async () => {
    await withFiles(
      { "openapi.json": oas("3.1", { info: { title: "Replacement \uFFFD", version: "1" } }) },
      async (dir) => {
        const generated = await run(["openapi.json"], dir)
        const bytes = Buffer.from(generated.stdout)
        const offset = bytes.indexOf(Buffer.from("\uFFFD"))
        expect(offset).toBeGreaterThan(-1)
        const corrupted = Buffer.concat([
          bytes.subarray(0, offset),
          Buffer.from([0xff]),
          bytes.subarray(offset + 3),
        ])
        expect(corrupted.toString("utf8")).toBe(generated.stdout)
        const target = join(dir, "api.ts")
        await fs.writeFile(target, corrupted)
        const before = await lstat(target)
        const line = bytes.subarray(0, offset).toString("utf8").split("\n").length
        const checked = await run(["openapi.json", "-o", "api.ts", "--check"], dir)
        expect(checked.code).toBe(1)
        expect(checked.stderr).toContain(`api.ts:${line}: expected:`)
        expect(checked.stderr).toContain(`api.ts:${line}: found:`)
        expect(checked.stderr).toMatch(/expected: .*\[hex: [\da-f]*efbfbd[\da-f]*\]/)
        expect(checked.stderr).toMatch(/found: .*\[hex: [\da-f]*ff[\da-f]*\]/)
        expect(checked.stderr).toContain("is out of date")
        expect(await readFile(target)).toStrictEqual(corrupted)
        const after = await lstat(target)
        expect(after.ino).toBe(before.ino)
        expect(after.mtimeMs).toBe(before.mtimeMs)
        const files = await readdir(dir)
        expect(files.toSorted()).toStrictEqual(["api.ts", "openapi.json"])
      },
    )
  })

  it("concurrent writers leave one complete output and no temporary files", async () => {
    await withFiles({ "a.json": spec, "b.json": oas("3.1", {}) }, async (dir) => {
      const a = await run(["a.json"], dir)
      const b = await run(["b.json"], dir)
      vi.spyOn(process, "cwd").mockReturnValue(dir)
      vi.spyOn(process.stderr, "write").mockReturnValue(true)
      const temporaryFiles = new Set()
      const ready = Promise.withResolvers<void>()
      const rename = fs.rename
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        temporaryFiles.add(from)
        if (temporaryFiles.size === 2) ready.resolve()
        await ready.promise
        await rename(from, to)
      })
      await Promise.all([
        runCommand(cli, { rawArgs: ["a.json", "-o", "api.ts"] }),
        runCommand(cli, { rawArgs: ["b.json", "-o", "api.ts"] }),
      ])
      expect(process.exitCode).toBeUndefined()
      expect([a.stdout, b.stdout]).toContain(await readFile(join(dir, "api.ts"), "utf8"))
      const files = await readdir(dir)
      expect(files.toSorted()).toStrictEqual(["a.json", "api.ts", "b.json"])
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

  it("reports unexpected generation errors without writing output", async () => {
    vi.spyOn(core, "generate").mockRejectedValue(new Error("unexpected failure"))
    expect(await run(["source.json"], process.cwd())).toStrictEqual({
      code: 1,
      stdout: "",
      stderr: "error: unexpected failure\n",
    })
  })

  it("rejects a negated output option before loading", async () => {
    const generate = vi.spyOn(core, "generate")
    const result = await run(["source.json", "--no-output"], process.cwd())
    expect(generate).not.toHaveBeenCalled()
    expect(result).toStrictEqual({
      code: 1,
      stdout: "",
      stderr: "error: --output must be a .ts or .mts module, got false; see openapi-shape --help\n",
    })
  })

  it("requires a source before loading, including with output options", async () => {
    const generate = vi.spyOn(core, "generate")
    await expect(runCommand(cli, { rawArgs: [] })).rejects.toThrow(
      "Missing required positional argument: SOURCE",
    )
    await expect(runCommand(cli, { rawArgs: ["-o", "api.ts", "--check"] })).rejects.toThrow(
      "Missing required positional argument: SOURCE",
    )
    expect(generate).not.toHaveBeenCalled()
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
    expect(usage).toContain("USAGE openapi-shape [OPTIONS] <SOURCE>")
    expect(usage).toContain("(Required)")
    expect(usage).toContain("--check")
    expect(usage).toContain("--max-document-size")
    expect(usage).not.toContain("--diagnostics")
    expect(usage).not.toContain("--fail-on")
  })
})
