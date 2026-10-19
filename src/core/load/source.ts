import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

type TextFormat = "json" | "yaml" | "unknown"

const FETCH_TIMEOUT = 30_000

export interface FetchedDocument {
  /** Retrieval URI after redirects, without fragment. */
  uri: string
  root: unknown
}

/** Read and parse a JSON or YAML document from a `file:` or `http(s):` URI. */
export async function fetchDocument(uri: string): Promise<FetchedDocument> {
  const url = new URL(uri)
  if (url.protocol === "file:") {
    const path = fileURLToPath(url)
    return { uri, root: parseText(await readFile(path, "utf8"), formatFromPath(path)) }
  }
  const response = await fetch(url, {
    headers: { accept: "application/json, application/yaml;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  let format: TextFormat = formatFromPath(url.pathname)
  if (contentType.includes("json")) format = "json"
  else if (contentType.includes("yaml")) format = "yaml"
  const finalUri = response.url === "" ? uri : withoutFragment(response.url)
  return { uri: finalUri, root: parseText(await response.text(), format) }
}

function parseText(text: string, format: TextFormat): unknown {
  if (format === "json") return JSON.parse(text)
  if (format !== "yaml") {
    try {
      return JSON.parse(text)
    } catch {
      // not JSON: read as YAML
    }
  }
  // YAML 1.1 merge keys (`<<: *common`) are common in OpenAPI documents.
  return assertAcyclic(parseYaml(text, { merge: true }))
}

/** YAML aliases (and in-memory objects) can form cycles, which no JSON document has. */
export function assertAcyclic(value: unknown): unknown {
  const stack = new Set<object>()
  const checked = new Set<object>()
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return
    if (stack.has(node)) throw new Error("the document refers to itself (a recursive YAML alias?)")
    if (checked.has(node)) return
    stack.add(node)
    for (const child of Object.values(node)) visit(child)
    stack.delete(node)
    checked.add(node)
  }
  visit(value)
  return value
}

function formatFromPath(path: string): TextFormat {
  const lower = path.toLowerCase()
  if (lower.endsWith(".json")) return "json"
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml"
  return "unknown"
}

export function withoutFragment(uri: string): string {
  const hash = uri.indexOf("#")
  return hash === -1 ? uri : uri.slice(0, hash)
}
