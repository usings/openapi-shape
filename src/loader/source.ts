import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LoadError } from "../errors";

/**
 * Read raw OpenAPI JSON from a path, file URL, or HTTP(S) URL.
 * The parsed value is intentionally unvalidated; validation starts in normalize().
 *
 * Accepted source forms:
 *   - "http://" or "https://" string: fetch
 *   - any other string: read as a file path
 *   - http:, https:, or file: URL: fetch or read file
 *   - any other URL protocol: LoadError
 *
 * `unknown` stays at the boundary so later stages can narrow the document shape.
 */
export async function readSource(source: string | URL): Promise<unknown> {
  const label = typeof source === "string" ? source : source.href;
  let text: string;

  try {
    text = await readText(source);
  } catch (err) {
    if (err instanceof LoadError) throw err;
    throw new LoadError(`Failed to read source: ${(err as Error).message}`, label);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LoadError(`Failed to parse source as JSON: ${(err as Error).message}`, label);
  }
}

async function readText(source: string | URL): Promise<string> {
  if (source instanceof URL) {
    if (source.protocol === "http:" || source.protocol === "https:") {
      return fetchText(source.href);
    }
    if (source.protocol === "file:") {
      return readFile(fileURLToPath(source), "utf-8");
    }
    throw new LoadError(
      `Unsupported URL protocol: ${source.protocol}. Supported: http:, https:, file:.`,
      source.href,
    );
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return fetchText(source);
  }
  return readFile(source, "utf-8");
}

async function fetchText(href: string): Promise<string> {
  const response = await fetch(href);
  if (!response.ok) {
    throw new LoadError(`Failed to fetch ${href}: ${response.status} ${response.statusText}`, href);
  }
  return response.text();
}
