#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import { generate } from "./index";

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
    const code = await generate(args.source, { headers: args.headers, errors: args.errors });

    if (args.check) {
      const target = resolve(args.output);
      const existing = await readFile(target, "utf8").catch(() => null);

      if (existing === code) {
        process.stdout.write(`${args.output} is up to date\n`);
        return;
      }

      reportStale(args.output, code, existing);
      process.exitCode = 1;
      return;
    }

    await writeFile(resolve(args.output), code, "utf8");
    process.stdout.write(`Generated ${args.output}\n`);
  },
});

function reportStale(output: string, expected: string, actual: string | null) {
  if (actual === null) {
    process.stderr.write(`${output}: missing — file does not exist\n`);
    return;
  }

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const delta = expectedLines.length - actualLines.length;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;

  process.stderr.write(
    `${output}: out of date\n` +
      `  current:    ${actualLines.length} lines\n` +
      `  expected:   ${expectedLines.length} lines (${sign})\n`,
  );
}

runMain(main);
