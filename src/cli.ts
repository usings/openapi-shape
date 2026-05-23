#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { styleText } from "node:util";
import { defineCommand, runMain } from "citty";
import { generate } from ".";

// --- CLI command definition

const main = defineCommand({
  meta: {
    name: "openapi-shape",
    description: "Generate TypeScript declarations and API shapes from OpenAPI JSON",
  },
  args: {
    source: {
      type: "positional",
      description: "Path to OpenAPI JSON file or HTTP(S) URL",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output file path",
      required: true,
    },
    check: {
      type: "boolean",
      description: "Exit non-zero if --output is missing or stale (CI)",
    },
    headers: {
      type: "boolean",
      description: "Emit a typed `headers` field per entry from `in: header` parameters",
    },
    errors: {
      type: "boolean",
      description: "Emit an `errors` field per entry, keyed by status code",
    },
  },
  async run({ args }) {
    const start = performance.now();

    info(`source: ${args.source}`);
    info(`output: ${args.output}${args.check ? " (check)" : ""}`);

    const target = resolve(args.output);
    const generateOptions = { headers: args.headers, errors: args.errors };

    if (args.check) {
      const [code, existing] = await Promise.all([
        generate(args.source, generateOptions),
        readFile(target, "utf8").catch(() => null),
      ]);
      const result = compareOutput(code, existing);
      if (result.kind === "fresh") {
        ok(`${args.output} is up to date in ${formatDuration(start)}`);
        return;
      }
      reportStale(args.output, result);
      process.exitCode = 1;
      return;
    }

    const code = await generate(args.source, generateOptions);
    const { bytes } = await writeOutput(target, code);
    ok(`Generated ${args.output} (${formatBytes(bytes)}) in ${formatDuration(start)}`);
  },
});

runMain(main);

// --- Utility functions and types

interface StaleReport {
  kind: "stale";
  existing: string | null;
  currentLines: number;
  expectedLines: number;
  lineDelta: number;
}

type CheckResult = { kind: "fresh" } | StaleReport;

function compareOutput(code: string, existing: string | null): CheckResult {
  if (existing === code) return { kind: "fresh" };

  const expectedLines = code.split("\n").length;
  const currentLines = existing === null ? 0 : existing.split("\n").length;
  return {
    kind: "stale",
    existing,
    currentLines,
    expectedLines,
    lineDelta: expectedLines - currentLines,
  };
}

async function writeOutput(target: string, code: string): Promise<{ bytes: number }> {
  await writeFile(target, code, "utf8");
  return { bytes: Buffer.byteLength(code, "utf8") };
}

function reportStale(output: string, result: StaleReport): void {
  if (result.existing === null) {
    fail(`${output}: file does not exist`);
    return;
  }
  const sign = result.lineDelta > 0 ? `+${result.lineDelta}` : `${result.lineDelta}`;
  fail(`${output} is out of date`);
  info(`  current:  ${result.currentLines} lines`);
  info(`  expected: ${result.expectedLines} lines (${sign})`);
}

function info(msg: string): void {
  process.stdout.write(`${styleText("cyan", "ℹ")} ${msg}\n`);
}

function ok(msg: string): void {
  process.stdout.write(`${styleText("green", "✔")} ${msg}\n`);
}

function fail(msg: string): void {
  process.stderr.write(`${styleText("red", "✘")} ${msg}\n`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(start: number): string {
  return `${Math.round(performance.now() - start)}ms`;
}
