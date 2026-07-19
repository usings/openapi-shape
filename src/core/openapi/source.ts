import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parse as parseYamlText } from "yaml"
import { LoadError } from "./errors"

/**
 * Read OpenAPI JSON or YAML from a file path, file URL, or HTTP(S) URL.
 *
 * File extensions and HTTP content types select the parser. Unknown formats try
 * JSON before YAML. The unvalidated result stays `unknown` until normalization.
 */
export async function readSource(source: string | URL): Promise<unknown> {
  const label = typeof source === "string" ? source : source.href
  let raw: RawSource

  try {
    raw = await readText(source)
  } catch (error) {
    if (error instanceof LoadError) throw error
    throw new LoadError(`Failed to read ${label}: ${errorMessage(error)}`, { cause: error })
  }

  return parseSource(raw, label)
}

type SourceFormat = "json" | "yaml" | "unknown"

interface RawSource {
  text: string
  format: SourceFormat
}

async function readText(source: string | URL): Promise<RawSource> {
  if (source instanceof URL) {
    if (source.protocol === "http:" || source.protocol === "https:") {
      return fetchText(source)
    }
    if (source.protocol === "file:") {
      const path = fileURLToPath(source)
      return { text: await readFile(path, "utf8"), format: formatFromPath(path) }
    }
    throw new LoadError(
      `Unsupported URL protocol: ${source.protocol} at ${source.href}. Supported: http:, https:, file:.`,
    )
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return fetchText(new URL(source))
  }
  return { text: await readFile(source, "utf8"), format: formatFromPath(source) }
}

async function fetchText(url: URL): Promise<RawSource> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new LoadError(`Failed to fetch ${url.href}: ${response.status} ${response.statusText}`)
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  let format: SourceFormat
  if (contentType.includes("json")) format = "json"
  else if (contentType.includes("yaml") || contentType.includes("yml")) format = "yaml"
  else format = formatFromPath(url.pathname)
  return { text: await response.text(), format }
}

function formatFromPath(path: string): SourceFormat {
  const p = path.toLowerCase()
  if (p.endsWith(".json")) return "json"
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return "yaml"
  return "unknown"
}

function parseSource({ text, format }: RawSource, label: string): unknown {
  if (format !== "unknown") return parseAs(format, text, label)
  try {
    return parseAs("json", text, label)
  } catch {
    return parseAs("yaml", text, label)
  }
}

function parseAs(format: "json" | "yaml", text: string, label: string): unknown {
  try {
    return format === "json" ? JSON.parse(text) : parseYamlText(text)
  } catch (error) {
    throw new LoadError(
      `Failed to parse ${label} as ${format.toUpperCase()}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
