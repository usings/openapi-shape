#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { styleText } from "node:util";
import { defineCommand, runMain } from "citty";
import { generate } from "./index";

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

    const code = await generate(args.source, { headers: args.headers, errors: args.errors });

    if (args.check) {
      const target = resolve(args.output);
      const existing = await readFile(target, "utf8").catch(() => null);

      if (existing === code) {
        ok(`${args.output} is up to date in ${formatDuration(start)}`);
        return;
      }

      reportStale(args.output, code, existing);
      process.exitCode = 1;
      return;
    }

    await writeFile(resolve(args.output), code, "utf8");
    const size = formatBytes(Buffer.byteLength(code, "utf8"));
    ok(`Generated ${args.output} (${size}) in ${formatDuration(start)}`);
  },
});

function reportStale(output: string, expected: string, actual: string | null): void {
  if (actual === null) {
    fail(`${output}: file does not exist`);
    return;
  }

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const delta = expectedLines.length - actualLines.length;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;

  fail(`${output} is out of date`);
  info(`  current:  ${actualLines.length} lines`);
  info(`  expected: ${expectedLines.length} lines (${sign})`);
}

runMain(main);
