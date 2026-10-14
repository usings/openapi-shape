import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..")
const TSC = join(ROOT, "node_modules", ".bin", "tsc")

/** Generated modules import their client types from the package, here its source. */
const DEFAULT_CONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "esnext",
    module: "nodenext",
    lib: ["esnext", "dom"],
    skipLibCheck: true,
    types: [],
    paths: { "openapi-shape/client": [join(ROOT, "src/client.ts")] },
  },
}

/**
 * Type-check files written to a temporary directory (so they can import each
 * other by name). Resolves to tsc's diagnostics, `""` when there are none.
 * Files may bring their own `tsconfig.json`.
 */
export async function typecheck(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openapi-shape-tsc-"))
  try {
    const all = { "tsconfig.json": JSON.stringify(DEFAULT_CONFIG), ...files }
    await Promise.all(Object.entries(all).map(([name, text]) => writeFile(join(dir, name), text)))
    return await new Promise((resolve) => {
      execFile(
        TSC,
        ["--project", "tsconfig.json"],
        { cwd: dir, maxBuffer: 64 * 1024 * 1024 },
        (_error, stdout, stderr) => {
          resolve(`${stdout}${stderr}`.trim())
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
