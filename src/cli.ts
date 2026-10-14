#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, styleText } from "node:util"
import type { ArgsDef, CommandDef } from "citty"
import { defineCommand, renderUsage, runMain } from "citty"
import pkg from "../package.json" with { type: "json" }
import type { Diagnostic } from "./index"
import { GenerateError, generate } from "./index"

const SHOWN_PER_CODE = 3

const command = defineCommand({
  meta: {
    name: "openapi-shape",
    version: pkg.version,
    description:
      "Generate a TypeScript module (types and the client contract) from an OpenAPI 3.0, 3.1, or 3.2 description.",
  },
  args: {
    source: {
      type: "positional",
      description: "File path or URL of a JSON or YAML document",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Write to this file instead of stdout (.d.ts: declarations only)",
      valueHint: "file",
    },
    check: {
      type: "boolean",
      description: "Exit with 1 if --output is not up to date; write nothing",
    },
    formats: {
      type: "string",
      description:
        "Map OpenAPI formats to TypeScript types (types only), e.g. int64=bigint; repeatable",
      valueHint: "name=type,...",
    },
  },
  async run({ args, cmd, rawArgs }) {
    // citty accepts any option; a typo such as --chek must not write the file.
    const known = new Set(["_", "source", "output", "o", "check", "formats"])
    const unknown = Object.keys(args).find((key) => !known.has(key))
    if (unknown !== undefined) return usageError(cmd, `Unknown option --${unknown}`)
    if (args._.length > 1) return usageError(cmd, `Expected one <source>, got ${args._.join(", ")}`)
    if (args.check && args.output === undefined) return usageError(cmd, "--check requires --output")
    // citty keeps only the last value of a repeated option.
    const given = optionValues(rawArgs)
    if (given.output.length > 1) return usageError(cmd, "--output can be given only once")
    const formats = parseFormats(given.formats)
    if (typeof formats === "string") return usageError(cmd, formats)
    // The output is TypeScript: a module, or with a declaration extension, types only.
    if (args.output !== undefined && !/\.[cm]?ts$/i.test(args.output)) {
      return usageError(cmd, `--output must be a .ts, .mts, or .cts file, got ${args.output}`)
    }

    const cwd = process.cwd()
    const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(args.source)
    let result
    try {
      // A declaration file cannot hold the runtime contract.
      const declarations = /\.d\.[cm]?ts$/i.test(args.output ?? "")
      result = await generate(isUrl ? args.source : resolve(cwd, args.source), {
        formats,
        declarations,
      })
    } catch (error) {
      if (!(error instanceof GenerateError)) throw error
      report(error.diagnostics, cwd)
      process.exitCode = 1
      return
    }
    report(result.diagnostics, cwd)

    if (args.output === undefined) {
      process.stdout.write(result.code)
      return
    }
    const target = resolve(cwd, args.output)
    const count = result.diagnostics.length
    const suffix = count === 0 ? "" : ` with ${count} warning${count === 1 ? "" : "s"}`
    if (args.check) {
      const existing = await readFile(target, "utf8").catch(() => null)
      if (existing === result.code) {
        process.stderr.write(`${mark("ok")} ${args.output} is up to date${suffix}\n`)
        return
      }
      const problem = existing === null ? "does not exist" : "is out of date"
      process.stderr.write(`${mark("error")} ${args.output} ${problem}\n`)
      if (existing !== null) process.stderr.write(firstDifference(existing, result.code))
      process.stderr.write("  Run the same command without --check to update it.\n")
      process.exitCode = 1
      return
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, result.code)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${mark("error")} Cannot write ${args.output}: ${reason}\n`)
      process.exitCode = 1
      return
    }
    process.stderr.write(`${mark("ok")} Wrote ${args.output}${suffix}\n`)
  },
})

await runMain(command)

/**
 * Every value given for `--output` (`-o`, `--o`) and `--formats`, as citty
 * reads them: node's parser, after citty drops `--no-*` flags.
 */
function optionValues(rawArgs: string[]): { output: string[]; formats: string[] } {
  const { tokens } = parseArgs({
    args: rawArgs.filter(
      (arg, i) => !arg.startsWith("--no-") || rawArgs.slice(0, i).includes("--"),
    ),
    options: {
      output: { type: "string", short: "o" },
      o: { type: "string" },
      formats: { type: "string" },
      check: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  })
  const values = { output: [] as string[], formats: [] as string[] }
  for (const token of tokens) {
    if (token.kind !== "option") continue
    const name = token.name === "o" ? "output" : token.name
    if (name === "output" || name === "formats") values[name].push(token.value ?? "")
  }
  return values
}

/**
 * `date-time=Date,int64=bigint`, from every `--formats`; a comma inside a type
 * (`Map<string, number>`) is kept.
 */
function parseFormats(values: string[]): Record<string, string> | string {
  const formats: Record<string, string> = {}
  for (const entry of values.flatMap((value) => value.split(/,(?=\s*[\w.-]+=)/))) {
    const eq = entry.indexOf("=")
    const name = entry.slice(0, eq).trim()
    const type = entry.slice(eq + 1).trim()
    if (eq <= 0 || name === "" || type === "") {
      return `--formats expects name=type pairs, got "${entry}"`
    }
    formats[name] = type
  }
  return formats
}

function report(diagnostics: Diagnostic[], cwd: string): void {
  const groups = Map.groupBy(diagnostics, (d) => `${d.severity} ${d.code}`)
  for (const group of groups.values()) {
    for (const d of group.slice(0, SHOWN_PER_CODE)) {
      process.stderr.write(
        `${mark(d.severity)} ${d.code}: ${d.message}\n    at ${location(d.location, cwd)}\n`,
      )
    }
    const rest = group.length - SHOWN_PER_CODE
    if (rest > 0) {
      process.stderr.write(
        `  … and ${rest} more ${group[0].code} ${group[0].severity}${rest === 1 ? "" : "s"}\n`,
      )
    }
  }
}

async function usageError<T extends ArgsDef>(cmd: CommandDef<T>, message: string): Promise<void> {
  process.stderr.write(`${await renderUsage(cmd)}\n\n${mark("error")} ${message}\n`)
  process.exitCode = 1
}

function mark(kind: "ok" | "error" | "warning"): string {
  if (kind === "ok") return styleText("green", "✔")
  if (kind === "error") return styleText("red", "error")
  return styleText("yellow", "warning")
}

/** Show file locations relative to the working directory. */
function location(value: string, cwd: string): string {
  if (!value.startsWith("file:")) return value
  const hash = value.indexOf("#")
  const uri = hash === -1 ? value : value.slice(0, hash)
  return `${relative(cwd, fileURLToPath(uri))}${hash === -1 ? "" : value.slice(hash)}`
}

function firstDifference(actual: string, expected: string): string {
  const a = actual.split("\n")
  const e = expected.split("\n")
  let line = 0
  while (line < a.length && line < e.length && a[line] === e[line]) line++
  return `  First difference at line ${line + 1}:\n    expected: ${e[line] ?? "<end of file>"}\n    found:    ${a[line] ?? "<end of file>"}\n`
}
