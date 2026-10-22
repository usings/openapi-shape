import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import { setImmediate } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

type TextFormat = "json" | "yaml" | "unknown"

const FETCH_TIMEOUT = 30_000

export interface FetchedDocument {
  /** Retrieval URI after redirects, without fragment. */
  uri: string
  root: unknown
}

/** Override retrieval of a file or HTTP(S) URI; undefined delegates to the built-in loader. */
export type DocumentLoader = (
  uri: string,
  context: { signal: AbortSignal },
) => Response | undefined | Promise<Response | undefined>

export interface LoadingOptions {
  /** Cancel loading and stop at generation checkpoints; rejection preserves signal.reason. */
  signal?: AbortSignal
  /** Override entry and external document retrieval, or return undefined to delegate. */
  load?: DocumentLoader
  /** Maximum concurrent document loads; a positive safe integer. Default: 8. */
  maxConcurrentLoads?: number
  /** Maximum bytes per loaded document; a positive safe integer. Default: 10 MiB. */
  maxDocumentBytes?: number
}

/** One generation's retrieval policy, shared by the entry document and every reference. */
export class DocumentReader {
  readonly concurrency: number
  private readonly maxBytes: number
  private lastYield = performance.now()

  constructor(private readonly options: LoadingOptions = {}) {
    this.concurrency = positiveInteger(options.maxConcurrentLoads, 8, "maxConcurrentLoads")
    this.maxBytes = positiveInteger(options.maxDocumentBytes, 10 * 1024 * 1024, "maxDocumentBytes")
  }

  throwIfAborted(): void {
    this.options.signal?.throwIfAborted()
  }

  /** Let a pending abort, such as a timeout, fire between synchronous generation stages. */
  async checkpoint(): Promise<void> {
    const { signal } = this.options
    if (signal === undefined) return
    await setImmediate()
    signal.throwIfAborted()
    this.lastYield = performance.now()
  }

  /** Yield between synchronous work units after a short time slice, only for cancellable runs. */
  workpoint(): Promise<void> | undefined {
    if (this.options.signal === undefined) return undefined
    this.throwIfAborted()
    return performance.now() - this.lastYield >= 8 ? this.checkpoint() : undefined
  }

  async read(source: string): Promise<FetchedDocument> {
    this.throwIfAborted()
    const uri = withoutFragment(source)
    const url = new URL(uri)
    if (!RETRIEVABLE.has(url.protocol)) {
      throw new Error(`Cannot retrieve "${uri}"; expected a file or HTTP(S) URI`)
    }
    const deadline = AbortSignal.timeout(FETCH_TIMEOUT)
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, deadline]) : deadline
    const loaded = await abortable(
      Promise.resolve().then(() => this.options.load?.(uri, { signal })),
      signal,
    )
    // Only undefined delegates; any fetch implementation's Response is accepted.
    if (loaded !== undefined && !isResponse(loaded)) {
      throw new TypeError("A document loader must return a Response or undefined")
    }
    const response = loaded ?? (await retrieve(url, signal))
    try {
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
      const finalUri = response.url === "" ? uri : withoutFragment(response.url)
      const finalUrl = new URL(finalUri)
      if (
        !RETRIEVABLE.has(finalUrl.protocol) ||
        (url.protocol !== "file:" && finalUrl.protocol === "file:")
      ) {
        throw new Error(`Cannot redirect ${uri} to ${finalUri}`)
      }
      const contentType = response.headers.get("content-type") ?? ""
      const mediaFormat = formatFromMediaType(contentType)
      const format = mediaFormat === "unknown" ? formatFromPath(finalUrl.pathname) : mediaFormat
      const text = await readText(response, signal, this.maxBytes)
      return { uri: finalUri, root: parseText(text, format) }
    } finally {
      discard(response)
    }
  }
}

const RETRIEVABLE = new Set(["file:", "http:", "https:"])

/** The built-in loader: a file's bytes, or an HTTP(S) response. */
function retrieve(url: URL, signal: AbortSignal): Response | Promise<Response> {
  if (url.protocol !== "file:") {
    const accept = "application/json, application/yaml;q=0.9, */*;q=0.5"
    return fetch(url, { headers: { accept }, signal })
  }
  const stream = createReadStream(fileURLToPath(url), { signal })
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>)
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

/**
 * A Response from any fetch implementation, whose body (if any) is a web stream that can be
 * cancelled.
 */
function isResponse(value: unknown): value is Response {
  if (typeof value !== "object" || value === null) return false
  const { ok, body } = value as Response
  return typeof ok === "boolean" && (body === null || body instanceof ReadableStream)
}

/** A loader's result, rejected as soon as `signal` aborts even if the loader ignores it. */
function abortable(pending: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    pending.then(
      (result) => {
        signal.removeEventListener("abort", abort)
        // A response that arrives after cancellation is disposed of.
        if (signal.aborted) discard(result)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

/**
 * Release a body that will not be read; one already read or being read is left alone. A loader's
 * result may be anything, and cleanup must not throw.
 */
function discard(response: unknown): void {
  try {
    const body = (response as Response | undefined)?.body
    if (body && !body.locked) void body.cancel().catch(ignore)
  } catch {
    // Not a web stream, so there is nothing this reader can release.
  }
}

function ignore(): void {
  // Cleanup must not replace the retrieval result.
}

/** Count actual bytes, including decompressed HTTP bodies, before retaining or parsing them. */
async function readText(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  signal.throwIfAborted()
  if (!response.body) return ""
  const reader = response.body.getReader()
  // Cancelling settles a pending read at once, even when the stream's own cleanup stalls.
  const cancel = (): void => {
    void reader.cancel().catch(ignore)
  }
  signal.addEventListener("abort", cancel, { once: true })
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  let reads = 0
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- each read advances this stream
      const { done, value } = await reader.read()
      // Reads that settle at once, even empty ones, run no timers: yield so an abort can fire.
      // oxlint-disable-next-line no-await-in-loop -- bound uninterrupted stream processing
      if (++reads % 64 === 0) await setImmediate()
      signal.throwIfAborted()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > maxBytes) {
        throw new Error(
          `Document is larger than ${maxBytes} bytes; raise the limit with --max-document-size or maxDocumentBytes`,
        )
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
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

/** Only the media subtype selects a parser; parameters can contain arbitrary names and URIs. */
function formatFromMediaType(value: string): TextFormat {
  const subtype = value.split(";", 1)[0].trim().toLowerCase().split("/", 2)[1] ?? ""
  if (subtype === "json" || subtype === "x-json" || subtype.endsWith("+json")) return "json"
  if (subtype === "yaml" || subtype === "x-yaml" || subtype.endsWith("+yaml")) return "yaml"
  return "unknown"
}

export function withoutFragment(uri: string): string {
  const hash = uri.indexOf("#")
  return hash === -1 ? uri : uri.slice(0, hash)
}
