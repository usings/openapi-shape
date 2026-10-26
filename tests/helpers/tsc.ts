import { execFile } from "node:child_process"
import { join } from "node:path"
import type { CompilerOptions } from "typescript"
import { expect } from "vitest"
import { withFiles } from "./tmp"

const ROOT = join(import.meta.dirname, "..", "..")
const TSC = join(ROOT, "node_modules", ".bin", "tsc")
/** Far beyond any check here; a compiler that hangs fails its test, not the run. */
const TIMEOUT = 120_000

/** Code that imports the client from the package gets its source. */
const DEFAULT_COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  target: "esnext",
  module: "esnext",
  moduleResolution: "bundler",
  lib: ["esnext", "dom"],
  skipLibCheck: true,
  types: [],
  paths: { "openapi-shape/client": [join(ROOT, "src/client/index.ts")] },
}

/**
 * Type-check files written to a temporary directory (so they can import each other by name).
 * Resolves to tsc's diagnostics, `""` when there are none, and rejects when tsc checked nothing.
 * Files may bring their own `tsconfig.json`.
 */
export async function typecheck(
  files: Record<string, string>,
  options: {
    /** Preserve generated suppressions when testing the consumer-facing file header itself. */
    checkGenerated?: boolean
    compilerOptions?: Pick<
      CompilerOptions,
      "exactOptionalPropertyTypes" | "noUncheckedIndexedAccess"
    >
  } = {},
): Promise<string> {
  const config = {
    compilerOptions: { ...DEFAULT_COMPILER_OPTIONS, ...options.compilerOptions },
  }
  // Generated files suppress consumer-side diagnostics; regression tests must check their bodies.
  const prepared = Object.fromEntries(
    Object.entries({ "tsconfig.json": JSON.stringify(config), ...files }).map(([name, text]) => [
      name,
      options.checkGenerated === false ? text : text.replaceAll(/^\/\/ @ts-nocheck\r?$/gm, ""),
    ]),
  )
  return await withFiles(
    prepared,
    (dir) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          TSC,
          ["--project", "tsconfig.json", "--pretty", "false"],
          { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT },
          (error, stdout, stderr) => {
            const diagnostics = `${stdout}${stderr}`.trim()
            // tsc exits 0 when it finds nothing, and 1 or 2 when it reports what
            // it found. One that does not start, is killed or times out, or exits
            // without a word has checked nothing.
            if (
              error === null ||
              ((error.code === 1 || error.code === 2) &&
                !error.killed &&
                !error.signal &&
                diagnostics !== "")
            ) {
              resolve(diagnostics)
            } else {
              reject(new Error(`tsc did not check the files: ${error.message}`, { cause: error }))
            }
          },
        )
      }),
  )
}

export async function expectPassesTsc(...codes: string[]): Promise<void> {
  const files = Object.fromEntries(codes.map((code, i) => [`file${i}.ts`, code]))
  expect(await typecheck(files)).toBe("")
}
