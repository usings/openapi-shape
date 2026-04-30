#!/usr/bin/env node
// src/cli.ts
import { generateFromSource } from "./index";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `Usage: openapi-shape <source> [-o <output>] [--errors] [--no-header] [--endpoint-key=method-path|operation-id]

  source                    Path to OpenAPI JSON file or HTTP(S) URL
  -o, --output <path>       Output file path (default: stdout)
      --errors              Include 4xx/5xx error response types
      --no-header           Omit the @generated JSDoc header
      --endpoint-key=KEY    'method-path' (default) or 'operation-id'`;

export type CliResult = { exitCode: number; stdout: string };

export async function runCli(argv: string[]): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
      errors: { type: "boolean" },
      "no-header": { type: "boolean" },
      "endpoint-key": { type: "string" },
    },
    allowPositionals: true,
  });

  if (values.help) return { exitCode: 0, stdout: HELP + "\n" };
  if (positionals.length === 0) return { exitCode: 1, stdout: HELP + "\n" };

  const ekRaw = values["endpoint-key"];
  if (ekRaw !== undefined && ekRaw !== "method-path" && ekRaw !== "operation-id") {
    return {
      exitCode: 1,
      stdout: `--endpoint-key must be 'method-path' or 'operation-id', got '${ekRaw}'\n`,
    };
  }

  const code = await generateFromSource(positionals[0], {
    errors: values.errors === true,
    header: values["no-header"] ? false : undefined,
    endpointKey: ekRaw === "method-path" || ekRaw === "operation-id" ? ekRaw : undefined,
  });

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
