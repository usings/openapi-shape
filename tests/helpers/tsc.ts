import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..")
const TSC = join(ROOT, "node_modules", ".bin", "tsc")
/** Far beyond any check here; a compiler that hangs fails its test, not the run. */
const TIMEOUT = 120_000

/** Code that imports the client from the package gets its source. */
const DEFAULT_CONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "esnext",
    module: "esnext",
    moduleResolution: "bundler",
    lib: ["esnext", "dom"],
    skipLibCheck: true,
    types: [],
    paths: { "openapi-shape/client": [join(ROOT, "src/client/index.ts")] },
  },
}

/**
 * Type-check files written to a temporary directory (so they can import each
 * other by name). Resolves to tsc's diagnostics, `""` when there are none,
 * and rejects when tsc checked nothing. Files may bring their own
 * `tsconfig.json`.
 */
export async function typecheck(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openapi-shape-tsc-"))
  try {
    const all = { "tsconfig.json": JSON.stringify(DEFAULT_CONFIG), ...files }
    await Promise.all(Object.entries(all).map(([name, text]) => writeFile(join(dir, name), text)))
    return await new Promise((resolve, reject) => {
      execFile(
        TSC,
        ["--project", "tsconfig.json"],
        { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT },
        (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.trim()
          // tsc exits 0 when it finds nothing, and 1 or 2 when it reports what
          // it found. One that does not start, is killed or times out, or exits
          // without a word has checked nothing.
          if (
            error === null ||
            ((error.code === 1 || error.code === 2) &&
              !error.killed &&
              !error.signal &&
              output !== "")
          ) {
            resolve(output)
          } else {
            reject(new Error(`tsc did not check the files: ${error.message}`, { cause: error }))
          }
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function expectPassesTsc(...codes: string[]): Promise<void> {
  const files = Object.fromEntries(codes.map((code, i) => [`file${i}.ts`, code]))
  expect(await typecheck(files)).toBe("")
}
