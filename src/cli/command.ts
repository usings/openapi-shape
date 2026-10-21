import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
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
    if (args.check && args.output === undefined) return usageError("--check requires --output")
    if (args.output !== undefined && !isModule(args.output)) {
      return usageError(`--output must be a .ts or .mts module, got ${args.output}`)
    }

    const size = args["max-document-size"]
    const maxDocumentBytes = size === undefined ? undefined : Number(size) * 1024 * 1024
    if (
      size !== undefined &&
      !(/^[1-9]\d*$/.test(size) && Number.isSafeInteger(maxDocumentBytes))
    ) {
      return usageError(`--max-document-size must be a positive whole number of MiB, got "${size}"`)
    }

    const cwd = process.cwd()
    const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(args.source)
    const source = isUrl ? args.source : relative(cwd, resolve(cwd, args.source))
    let result
    try {
      result = await generate(isUrl ? args.source : resolve(cwd, args.source), { maxDocumentBytes })
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
    const target = resolve(cwd, args.output)
    const warnings = result.diagnostics.length === 0 ? "" : ` (${counts(result.diagnostics)})`
    if (args.check) {
      let existing: string | null = null
      try {
        existing = await readFile(target, "utf8")
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          const reason = error instanceof Error ? error.message : String(error)
          return fail(`Cannot read ${args.output}: ${reason}`)
        }
      }
      if (existing === result.code) {
        process.stderr.write(`${args.output} is up to date${warnings}\n`)
        return
      }
      if (existing === null) {
        return fail(
          `${args.output} does not exist; run the same command without --check to write it`,
        )
      }
      process.stderr.write(firstDifference(args.output, existing, result.code))
      return fail(
        `${args.output} is out of date; run the same command without --check to update it`,
      )
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, result.code)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return fail(`Cannot write ${args.output}: ${reason}`)
    }
    process.stderr.write(`Wrote ${args.output}${warnings}\n`)
  },
})

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
function firstDifference(file: string, actual: string, expected: string): string {
  const a = actual.split("\n")
  const e = expected.split("\n")
  let line = 0
  while (line < a.length && line < e.length && a[line] === e[line]) line++
  const at = `${file}:${line + 1}:`
  return `${at} expected: ${e[line] ?? "<end of file>"}\n${at} found:    ${a[line] ?? "<end of file>"}\n`
}
