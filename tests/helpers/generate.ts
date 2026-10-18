import type { Diagnostic, GenerateOptions, GenerateResult } from "../../src/index"
import { generate } from "../../src/index"

export type Version = "3.0" | "3.1" | "3.2"

const FULL_VERSION: Record<Version, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.0" }

/** A minimal OpenAPI document of the given version. */
export function oas(
  version: Version,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { openapi: FULL_VERSION[version], info: { title: "Test", version: "1" }, ...fields }
}

export function withSchemas(
  version: Version,
  schemas: Record<string, unknown>,
): Record<string, unknown> {
  return oas(version, { components: { schemas } })
}

export async function gen(doc: object, options?: GenerateOptions): Promise<string> {
  const { code } = await generate(doc, options)
  return code
}

export function genResult(doc: object, options?: GenerateOptions): Promise<GenerateResult> {
  return generate(doc, options)
}

/** Diagnostic codes with their locations, for compact assertions. */
export function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((d) => `${d.code} ${d.location}`)
}

/**
 * The rendered type of one schema: the right-hand side of `type T = …`, or the body of `interface T
 * { … }` (dedented).
 */
export async function typeOf(schema: unknown, version: Version = "3.1"): Promise<string> {
  return declaration(await gen(withSchemas(version, { T: schema })), "T")
}

/** Extract one declaration from the `Schemas` namespace: alias right-hand side or interface body. */
export function declaration(code: string, name: string): string {
  const alias = new RegExp(`^  export type ${escape(name)} = `, "m").exec(code)
  const iface = new RegExp(`^  export interface ${escape(name)} \\{`, "m").exec(code)
  const match = alias ?? iface
  if (!match) throw new Error(`No declaration ${name} in:\n${code}`)
  const start = match.index + match[0].length
  const rest = code.slice(start)
  const end = rest.search(alias ? /\n\n|\n}\n/ : /\n {2}}\n/)
  const text = rest.slice(0, end === -1 ? undefined : end)
  return dedent(alias ? text : `{${text}\n}`, 2)
}

/** Extract one operation entry (`"GET /x": { … }`) from an interface, dedented. */
export function entry(code: string, key: string): string {
  const head = `  ${JSON.stringify(key)}: {\n`
  const at = code.indexOf(head)
  if (at === -1) throw new Error(`No entry ${key} in:\n${code}`)
  const rest = code.slice(at + head.length)
  const end = rest.indexOf("\n  }")
  return dedent(`{\n${rest.slice(0, end)}\n}`, 2)
}

function dedent(text: string, width: number): string {
  const prefix = " ".repeat(width)
  return text
    .split("\n")
    .map((line) => (line.startsWith(prefix) ? line.slice(width) : line))
    .join("\n")
}

function escape(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
