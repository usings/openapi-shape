import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import ts from "typescript"
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

/** Static dependencies, including side effects, re-exports, and literal dynamic imports. */
function importsOf(text: string): string[] {
  const file = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  const visit = (node: ts.Node): void => {
    let specifier: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0]
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal
    } else if (ts.isExternalModuleReference(node)) {
      specifier = node.expression
    }
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) imports.push(specifier.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return imports
}

it("finds dependencies in import syntax, ignoring comments and ordinary strings", () => {
  expect(
    importsOf(
      [
        'import { readFile } from "node:fs"',
        'import "./side-effect"',
        'export * from "./exported"',
        'const lazy = () => import("./lazy")',
        'type T = import("./types").T',
        'import legacy = require("./legacy")',
        '// import "./comment"',
        "const text = 'import \"./string\"'",
      ].join("\n"),
    ),
  ).toStrictEqual(["node:fs", "./side-effect", "./exported", "./lazy", "./types", "./legacy"])
})

it("imports flow one way between the parts of src/", () => {
  const violations: string[] = []
  for (const file of sources(SRC)) {
    const part = partOf(file)
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
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
