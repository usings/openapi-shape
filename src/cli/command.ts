import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { styleText } from "node:util"
import { defineCommand } from "citty"
import pkg from "../../package.json" with { type: "json" }
import type { Diagnostic } from "../core"
import { GenerateError, generate } from "../core"

/** The `openapi-shape` command, which the bin (`./index.ts`) runs. */
export const cli = defineCommand({
  meta: {
    name: "openapi-shape",
    version: pkg.version,
    description:
      "Generate a TypeScript module (types and the client contract) from an OpenAPI 3.0, 3.1, or 3.2 description.",
  },
  args: {
    "source": {
      type: "positional",
      description: "File path or URL of a JSON or YAML document",
      required: true,
    },
    "output": {
      type: "string",
      alias: "o",
      description: "Write to this file, a .ts or .mts module, instead of stdout",
      valueHint: "file",
    },
    "check": {
      type: "boolean",
      description: "Exit with 1 if --output is not up to date; write nothing",
    },
    "max-document-size": {
      type: "string",
      description: "Largest document to load, in MiB (1 MiB = 1,048,576 bytes; default 10)",
      valueHint: "MiB",
    },
  },
  async run({ args }) {
    try {
      if (args.check && args.output === undefined) return usageError("--check requires --output")
      if (
        args.output !== undefined &&
        (typeof args.output !== "string" || !isModule(args.output))
      ) {
        return usageError(`--output must be a .ts or .mts module, got ${args.output}`)
      }

      const size = args["max-document-size"]
      const maxDocumentBytes = size === undefined ? undefined : Number(size) * 1024 * 1024
      if (
        size !== undefined &&
        !(/^[1-9]\d*$/.test(size) && Number.isSafeInteger(maxDocumentBytes))
      ) {
        return usageError(
          `--max-document-size must be a positive whole number of MiB, got "${size}"`,
        )
      }

      const cwd = process.cwd()
      const isUrl = /^[a-z][a-z\d+.-]*:/i.test(args.source) && !/^[a-z]:[\\/]/i.test(args.source)
      const source = isUrl ? args.source : relative(cwd, resolve(cwd, args.source))
      let result
      try {
        result = await generate(isUrl ? args.source : resolve(cwd, args.source), {
          maxDocumentBytes,
        })
      } catch (error) {
        if (!(error instanceof GenerateError)) throw error
        report(error.diagnostics, source, cwd)
        return fail(`Generation failed (${counts(error.diagnostics)})`)
      }
      report(result.diagnostics, source, cwd)

      if (args.output === undefined) {
        process.stdout.write(result.code)
        return
      }
      // Preserve `..` until the filesystem has followed any preceding directory symlinks.
      const target = isAbsolute(args.output) ? args.output : `${cwd}/${args.output}`
      const warnings = result.diagnostics.length === 0 ? "" : ` (${counts(result.diagnostics)})`
      if (args.check) {
        const expected = Buffer.from(result.code)
        let existing: Buffer | null = null
        try {
          existing = await readFile(target)
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            const reason = error instanceof Error ? error.message : String(error)
            return fail(`Cannot read ${args.output}: ${reason}`)
          }
        }
        if (existing?.equals(expected)) {
          process.stderr.write(`${args.output} is up to date${warnings}\n`)
          return
        }
        if (existing === null) {
          return fail(
            `${args.output} does not exist; run the same command without --check to write it`,
          )
        }
        process.stderr.write(firstDifference(args.output, existing, expected))
        return fail(
          `${args.output} is out of date; run the same command without --check to update it`,
        )
      }
      try {
        await mkdir(dirname(target), { recursive: true })
        await replaceOutput(target, result.code)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return fail(`Cannot write ${args.output}: ${reason}`)
      }
      process.stderr.write(`Wrote ${args.output}${warnings}\n`)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  },
})

/** Replace a complete file in one rename, following existing symlinks without replacing them. */
async function replaceOutput(target: string, code: string): Promise<void> {
  const destination = await outputDestination(target)
  const existing = await stat(destination).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    return null
  })
  let mode: number | undefined
  if (existing !== null) {
    await access(destination, constants.W_OK)
    if (!existing.isFile()) throw new Error("Output target is not a regular file")
    mode = existing.mode & 0o777
  }
  const directory = await realpath(dirname(destination))
  const temporary = join(directory, `.openapi-shape-${randomUUID()}.tmp`)
  const file = await open(temporary, "wx", mode ?? 0o666)
  try {
    try {
      await file.writeFile(code)
      if (mode !== undefined) await file.chmod(mode)
    } finally {
      await file.close()
    }
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Follow dangling links too, without creating directories at their destinations. */
async function outputDestination(target: string, links = 0): Promise<string> {
  try {
    return await realpath(target)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  const link = await readlink(target).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    return null
  })
  if (link === null) return target
  if (links >= 40) throw new Error("Too many symbolic links in output target")
  const parent = await realpath(dirname(target))
  // Keep link text intact: normalizing `..` before following directory symlinks changes its meaning.
  return outputDestination(isAbsolute(link) ? link : `${parent}/${link}`, links + 1)
}

/**
 * A file TypeScript reads as an ES module: `.ts` or `.mts`, but not a declaration file, which
 * TypeScript tells by `.d.` in its name.
 */
function isModule(path: string): boolean {
  const name = basename(path).toLowerCase()
  return /\.m?ts$/.test(name) && !name.includes(".d.")
}

/**
 * One line per diagnostic, as compilers write them, so that a CI log or an agent can read each on
 * its own: `<location>: <severity> <code>: <message>`.
 */
function report(diagnostics: Diagnostic[], source: string, cwd: string): void {
  for (const d of diagnostics) {
    const at = where(d.location, source, cwd)
    process.stderr.write(`${at}: ${severity(d.severity)} ${d.code}: ${d.message}\n`)
  }
}

/** The last line of a failed run, which says what failed; the exit code is 1. */
function fail(message: string): void {
  process.stderr.write(`${severity("error")}: ${message}\n`)
  process.exitCode = 1
}

function usageError(message: string): void {
  fail(`${message}; see openapi-shape --help`)
}

/** `2 errors, 1 warning` */
function counts(diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error").length
  const warnings = diagnostics.length - errors
  return [
    [errors, "error"],
    [warnings, "warning"],
  ]
    .filter(([n]) => n !== 0)
    .map(([n, noun]) => `${n} ${noun}${n === 1 ? "" : "s"}`)
    .join(", ")
}

/** In color only where stderr is a terminal that takes it (`NO_COLOR` and `FORCE_COLOR` apply). */
function severity(kind: Diagnostic["severity"]): string {
  return styleText(kind === "error" ? "red" : "yellow", kind, { stream: process.stderr })
}

/**
 * A diagnostic's location: the source's own pointers after its name, and other files relative to
 * the working directory.
 */
function where(location: string, source: string, cwd: string): string {
  if (location.startsWith("#")) return `${source}${location}`
  if (!location.startsWith("file:")) return location
  const hash = location.indexOf("#")
  const uri = hash === -1 ? location : location.slice(0, hash)
  return `${relative(cwd, fileURLToPath(uri))}${hash === -1 ? "" : location.slice(hash)}`
}

/** The first line where `file` differs from what would be written, as `<file>:<line>:` lines. */
function firstDifference(file: string, actual: Buffer, expected: Buffer): string {
  let offset = 0
  let line = 1
  let start = 0
  while (
    offset < actual.length &&
    offset < expected.length &&
    actual[offset] === expected[offset]
  ) {
    if (actual[offset] === 10) {
      line++
      start = offset + 1
    }
    offset++
  }
  const aEnd = actual.indexOf(10, start)
  const eEnd = expected.indexOf(10, start)
  const a = actual.subarray(start, aEnd === -1 ? undefined : aEnd)
  const e = expected.subarray(start, eEnd === -1 ? undefined : eEnd)
  let found = a.toString("utf8")
  let wanted = e.toString("utf8")
  if (found === wanted) {
    found += ` [hex: ${actual.subarray(start, aEnd === -1 ? undefined : aEnd + 1).toString("hex")}]`
    wanted += ` [hex: ${expected.subarray(start, eEnd === -1 ? undefined : eEnd + 1).toString("hex")}]`
  }
  const at = `${file}:${line}:`
  return `${at} expected: ${wanted}\n${at} found:    ${found}\n`
}
