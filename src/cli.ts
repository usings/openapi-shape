#!/usr/bin/env node
import { generateFromSource } from "./index";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `Usage: openapi-shape <source> [-o <output>]

  source   Path to OpenAPI JSON file or HTTP(S) URL
  -o       Output file path (default: stdout)

Examples:
  openapi-shape ./openapi.json
  openapi-shape ./openapi.json -o api.ts
  openapi-shape https://example.com/openapi.json -o api.ts`;

export type CliResult = { exitCode: number; stdout: string };

export async function runCli(argv: string[]): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) return { exitCode: 0, stdout: HELP + "\n" };
  if (positionals.length === 0) return { exitCode: 1, stdout: HELP + "\n" };

  const code = await generateFromSource(positionals[0]);

  if (values.output) {
    await writeFile(resolve(values.output), code, "utf-8");
    return { exitCode: 0, stdout: `Generated ${values.output}\n` };
  }

  return { exitCode: 0, stdout: code };
}

// auto-run when invoked as bin (skipped when imported by tests)
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
