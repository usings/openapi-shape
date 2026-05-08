#!/usr/bin/env node
import { generate } from "./index";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `Usage: openapi-shape <source> [-o <output>] [--check]

  source                    Path to OpenAPI JSON file or HTTP(S) URL
  -o, --output <path>       Output file path (default: stdout)
  --check                   Exit non-zero if --output is missing or stale (CI)`;

export type CliResult = { exitCode: number; stdout: string };

export async function runCli(argv: string[]): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
      check: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.help) return { exitCode: 0, stdout: HELP + "\n" };
  if (positionals.length === 0) return { exitCode: 1, stdout: HELP + "\n" };
  if (values.check && !values.output) {
    return { exitCode: 1, stdout: "--check requires --output <path>\n" };
  }

  const code = await generate(positionals[0]);

  if (values.check && values.output) {
    const target = resolve(values.output);
    const existing = await readFile(target, "utf-8").catch(() => null);
    if (existing === code) {
      return { exitCode: 0, stdout: `${values.output} is up to date\n` };
    }
    return { exitCode: 1, stdout: `${values.output} is out of date — re-run without --check\n` };
  }

  if (values.output) {
    await writeFile(resolve(values.output), code, "utf-8");
    return { exitCode: 0, stdout: `Generated ${values.output}\n` };
  }

  return { exitCode: 0, stdout: code };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(
    ({ exitCode, stdout }) => {
      process.stdout.write(stdout);
      process.exit(exitCode);
    },
    (err) => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    },
  );
}
