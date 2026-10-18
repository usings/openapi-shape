import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { expect, it } from "vitest"

// What each part of src/ may import. The generator is a pipeline, load → build
// → render, around the model; the client ships alone, so it imports nothing
// outside itself, and nothing in the generator imports it.
const SRC = join(import.meta.dirname, "..", "src")
const MAY_IMPORT: Record<string, string[]> = {
  "index": ["core/load", "core/build", "core/render", "core/shared"],
  "cli": ["cli", "index"],
  "client": ["client"],
  "core/shared": ["core/shared"],
  "core/load": ["core/load", "core/shared"],
  "core/model": ["core/model", "core/shared"],
  "core/build": ["core/build", "core/load", "core/model", "core/shared"],
  "core/render": ["core/render", "core/model", "core/shared"],
}
// Only these reach files, the network, or packages.
const MAY_IMPORT_PACKAGES = new Set(["cli", "core/load"])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  )
}

/** `client`, `core/build`, `index`, …: the part of src/ a file belongs to. */
function partOf(file: string): string {
  const path = relative(SRC, file).replace(/\.ts$/, "")
  const [top, stage] = path.split("/")
  return top === "core" ? `core/${stage}` : top
}

function resolveSource(from: string, specifier: string): string | undefined {
  const base = join(dirname(from), specifier)
  return [`${base}.ts`, join(base, "index.ts")].find((file) => existsSync(file))
}

it("imports flow one way between the parts of src/", () => {
  const violations: string[] = []
  for (const file of sources(SRC)) {
    const part = partOf(file)
    // Import and export statements, also over several lines; not code in strings.
    const statements = readFileSync(file, "utf8").matchAll(
      /^(?:import|export)\s[\w*{},\s]*?\bfrom "([^"]+)"/gm,
    )
    for (const [, specifier] of statements) {
      const at = `${relative(SRC, file)} imports "${specifier}"`
      if (!specifier.startsWith(".")) {
        // Bounded pattern matching uses Node's execution deadline, without file or network I/O.
        const boundedPatterns =
          relative(SRC, file) === "core/shared/patterns.ts" && specifier === "node:vm"
        if (!MAY_IMPORT_PACKAGES.has(part) && !boundedPatterns) violations.push(at)
        continue
      }
      const target = resolveSource(file, specifier)
      // The CLI reads its version from package.json, outside src/.
      if (target === undefined) {
        if (!(part === "cli" && specifier.endsWith("package.json"))) violations.push(at)
        continue
      }
      if (!MAY_IMPORT[part]?.includes(partOf(target))) violations.push(at)
    }
  }
  expect(violations).toStrictEqual([])
})
