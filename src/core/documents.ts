import { resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import type { Diagnostics } from "./diagnostics"
import type { DocumentReader, FetchedDocument } from "./document-reader"
import { assertAcyclic, withoutFragment } from "./document-reader"
import { appendPointer, parsePointer, readPointer } from "./json-pointer"
import { isRecord } from "./object"

type OpenApiVersion = "3.0" | "3.1" | "3.2"

/** One parsed document of an OpenAPI Description. */
interface LoadedDocument {
  /** Retrieval URI, without fragment. */
  uri: string
  /** Base URI for relative references: `$self` (3.2) resolved against `uri`. */
  base: string
  root: unknown
  /** The document's own OpenAPI version, or the entry document's for schema documents. */
  version: OpenApiVersion
  /** Retrieved over HTTP(S); such documents may not reference local files. */
  remote: boolean
  /** The base URI each `$id` resource in it sets, by pointer (3.1+). */
  bases: Map<string, string>
  /** Subtrees omitted from the resource index unless explicitly reached as external schemas. */
  excluded: Map<string, { value: unknown; base: string; owned: boolean }>
}

/** A value inside a document together with the base URI in effect there. */
export interface DocumentNode {
  document: LoadedDocument
  pointer: string
  value: unknown
  base: string
}

type Resolution =
  | { kind: "found"; node: DocumentNode }
  /** The target needs loading or indexing; the caller should retry after `loadPending`. */
  | { kind: "pending" }
  | { kind: "error"; message: string }

/** Base URI used for in-memory documents; relative references cannot leave it. */
const MEMORY_SCHEME = "openapi-shape:"
const MEMORY_URI = `${MEMORY_SCHEME}/memory`

// Under these keys an object maps arbitrary names to values, so its keys are never keywords.
const NAME_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "schemas",
  "responses",
  "parameters",
  "requestBodies",
  "headers",
  "callbacks",
  "pathItems",
  "mediaTypes",
  "paths",
  "webhooks",
  "content",
  "encoding",
  "securitySchemes",
])
// Name maps whose names (paths, status codes) never start with `x-`: such a key is an extension.
const EXTENSIBLE_MAPS = new Set(["paths", "responses"])
// Fields whose values are never schemas: instance data, and Links. Extensions (`x-`) are not either.
const NO_SCHEMAS = new Set(["example", "examples", "const", "enum", "default", "links"])

const MAX_LOAD_ROUNDS = 64

function parseOpenApiVersion(value: unknown): OpenApiVersion | undefined {
  if (typeof value !== "string") return undefined
  const match = /^3\.([0-2])\.\d+(?:-[\w.-]+)?$/.exec(value)
  return match ? (`3.${match[1]}` as OpenApiVersion) : undefined
}

/** Resolve `ref` against `base` per RFC 3986; `undefined` when it is not a valid URI reference. */
function resolveUri(ref: string, base: string): string | undefined {
  try {
    return new URL(ref, base).href
  } catch {
    return undefined
  }
}

/** Turn a CLI/API source into an absolute URI. */
function sourceUri(source: string | URL): string {
  if (source instanceof URL) return source.href
  // Through URL, so that `FILE:` and dot segments name one document one way.
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) {
    // An invalid URL is kept as written: reading it then fails, and says so.
    return resolveUri(source, source) ?? source
  }
  return pathToFileURL(resolvePath(source)).href
}

/**
 * The documents of an OpenAPI Description, addressed by URI.
 *
 * References into documents that are not loaded yet resolve to `pending`; `loadPending` fetches
 * them so the caller can build again. Documents are immutable once added, so repeated builds see
 * identical inputs.
 */
export class DocumentSet {
  readonly entry: LoadedDocument
  private readonly resources = new Map<string, DocumentNode>()
  private readonly anchors = new Map<string, DocumentNode>()
  private readonly pending = new Set<string>()
  private readonly failed = new Map<string, string>()
  private readonly schemaTargets = new Map<LoadedDocument, Set<string>>()
  private rounds = 0

  /**
   * Made by {@link loadDocuments}.
   *
   * @param retrieval Whether other documents may be loaded. An in-memory document without a `base`
   *   has no location to load anything relative to, and must not reach files or the network by
   *   absolute URIs either.
   */
  constructor(
    entry: LoadedDocument,
    private readonly retrieval: boolean,
    readonly reader: DocumentReader,
  ) {
    this.entry = entry
    this.register(entry)
  }

  get hasPending(): boolean {
    return this.pending.size > 0 || this.schemaTargets.size > 0
  }

  /**
   * Index schema targets or load requested documents between builds. Returns false at the load
   * limit.
   */
  async loadPending(): Promise<boolean> {
    if (this.schemaTargets.size > 0) {
      for (const [document, targets] of this.schemaTargets) {
        for (const target of targets) {
          let pointer = ""
          for (const token of parsePointer(target) ?? []) {
            pointer = appendPointer(pointer, token)
            const excluded = document.excluded.get(pointer)
            if (excluded === undefined) continue
            document.excluded.delete(pointer)
            this.indexResources(document, excluded.value, pointer, excluded.base, excluded.owned)
          }
        }
      }
      this.schemaTargets.clear()
      // Rebuild before fetching: newly indexed $ids may satisfy earlier requests.
      this.pending.clear()
      return true
    }
    if (this.pending.size === 0 || ++this.rounds > MAX_LOAD_ROUNDS) return false
    const uris = [...this.pending]
    this.pending.clear()
    const fetched: Array<{ document: FetchedDocument } | { error: unknown }> = []
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < uris.length) {
        const index = cursor++
        try {
          // oxlint-disable-next-line no-await-in-loop -- each worker loads one document at a time
          fetched[index] = { document: await this.reader.read(uris[index]) }
        } catch (error) {
          // Cancellation stops every worker; any other failure belongs to its document.
          this.reader.throwIfAborted()
          fetched[index] = { error }
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(this.reader.concurrency, uris.length) }, worker),
    )
    // Registered in the order they were asked for, not as they arrive: when
    // two documents claim one URI, the same one wins every time.
    uris.forEach((uri, i) => {
      const result = fetched[i]
      if ("document" in result) this.add(uri, result.document)
      else this.failed.set(uri, `cannot read ${uri}: ${errorMessage(result.error)}`)
    })
    return true
  }

  /** Diagnostic location for a node: `#/pointer` in the entry document, `uri#/pointer` elsewhere. */
  locate(document: LoadedDocument, pointer: string): string {
    return document === this.entry ? `#${pointer}` : `${document.uri}#${pointer}`
  }

  root(document: LoadedDocument): DocumentNode {
    let base = document.base
    // A schema document's own `$id` sets its base; an OpenAPI document's root has none.
    const root = document.root
    if (document.version !== "3.0" && isRecord(root) && !("openapi" in root)) {
      base = resourceBase(document, root, base) ?? base
    }
    return { document, pointer: "", value: root, base }
  }

  /** Child node, with the base URI of the `$id` resources it is in (3.1+). */
  child(node: DocumentNode, ...segments: Array<string | number>): DocumentNode {
    let { value, pointer, base } = node
    for (const segment of segments) {
      value = readPointer(value, [String(segment)])
      pointer = appendPointer(pointer, segment)
      // The index decides which `$id`s start a resource, so that references
      // never resolve against a base it did not register.
      base = node.document.bases.get(pointer) ?? base
    }
    return { document: node.document, pointer, value, base }
  }

  /** Resolve a `$ref` (or `$dynamicRef`, statically) relative to the node it appears in. */
  resolve(ref: string, from: DocumentNode): Resolution {
    const resolution = this.lookup(ref, from)
    if (resolution.kind !== "found" || !from.document.remote || resolution.node.document.remote) {
      return resolution
    }
    // A remote document reaches a local one only at the address it publishes as
    // its `$self` (with a pointer or anchor there), not by URIs its `$id`s claim.
    const target = resolution.node.document
    const absolute = withoutFragment(resolveUri(ref, from.base) ?? "")
    if (target.base !== target.uri && absolute === target.base) return resolution
    return {
      kind: "error",
      message: `remote document cannot reference local document ${target.uri}`,
    }
  }

  /** A schema pointer can identify a dictionary entry whose name otherwise looks like metadata. */
  resolveSchema(ref: string, from: DocumentNode): Resolution {
    const resolution = this.resolve(ref, from)
    if (resolution.kind !== "found") return resolution
    const { document, pointer } = resolution.node
    if (isRecord(document.root) && "openapi" in document.root) return resolution
    let at = ""
    for (const token of parsePointer(pointer) ?? []) {
      at = appendPointer(at, token)
      if (!document.excluded.has(at)) continue
      let targets = this.schemaTargets.get(document)
      if (targets === undefined) {
        targets = new Set()
        this.schemaTargets.set(document, targets)
      }
      targets.add(pointer)
      return { kind: "pending" }
    }
    return resolution
  }

  private lookup(ref: string, from: DocumentNode): Resolution {
    const absolute = resolveUri(ref, from.base)
    if (absolute === undefined) return { kind: "error", message: `"${ref}" is not a valid URI` }
    const hash = absolute.indexOf("#")
    const docUri = hash === -1 ? absolute : absolute.slice(0, hash)
    let fragment = hash === -1 ? "" : absolute.slice(hash + 1)
    try {
      fragment = decodeURIComponent(fragment)
    } catch {
      return { kind: "error", message: `"${ref}" has an invalid percent-encoded fragment` }
    }

    // A remote document may not reach local files, whether or not they are loaded.
    if (from.document.remote && isFileUri(docUri)) {
      return { kind: "error", message: `remote document cannot reference local file ${docUri}` }
    }
    const resource = this.resources.get(docUri)
    if (resource === undefined) {
      const failure = this.failed.get(docUri)
      if (failure !== undefined) return { kind: "error", message: failure }
      if (!this.retrieval || docUri.startsWith(MEMORY_SCHEME)) {
        return {
          kind: "error",
          message: `"${ref}" points outside an in-memory document; pass the \`base\` option to resolve it`,
        }
      }
      if (!/^(?:https?|file):/i.test(docUri)) {
        return { kind: "error", message: `cannot retrieve "${docUri}"` }
      }
      this.pending.add(docUri)
      return { kind: "pending" }
    }

    if (fragment === "") return { kind: "found", node: resource }
    if (fragment.startsWith("/")) {
      const pointer = resource.pointer + fragment
      const tokens = parsePointer(pointer)
      const target = tokens && this.child(this.root(resource.document), ...tokens)
      if (target?.value === undefined) return { kind: "error", message: `"${ref}" does not exist` }
      return { kind: "found", node: target }
    }
    const anchored = this.anchors.get(`${docUri}#${fragment}`)
    if (anchored === undefined) return { kind: "error", message: `anchor "${ref}" does not exist` }
    return { kind: "found", node: anchored }
  }

  private add(uri: string, fetched: FetchedDocument): void {
    const root = fetched.root
    let version = this.entry.version
    if (isRecord(root) && root.openapi !== undefined) {
      const own = parseOpenApiVersion(root.openapi)
      if (own === undefined) {
        this.failed.set(uri, `${uri} declares unsupported OpenAPI version ${String(root.openapi)}`)
        return
      }
      version = own
    }
    const document = createDocument(fetched.uri, root, version, /^https?:/i.test(fetched.uri))
    this.register(document)
    // A redirect leaves the requested URI pointing at the same document.
    if (!this.resources.has(uri)) this.resources.set(uri, this.root(document))
  }

  /** The first document to claim a URI keeps it, so a later one cannot shadow it. */
  private register(document: LoadedDocument): void {
    const root = this.root(document)
    this.claim(this.resources, document.uri, root)
    this.claim(this.resources, document.base, root)
    if (document.version === "3.0") return
    const owned = this.owns(document.base, document, "")
    this.indexResources(document, document.root, "", document.base, owned)
  }

  /**
   * Index the `$id` resources and `$anchor`/`$dynamicAnchor` names at `value` and below (JSON
   * Schema 2020-12 Core, "Base URI, Anchors, and Dereferencing"). An anchor belongs to its
   * resource: one whose URI another claimed first registers none.
   */
  private indexResources(
    document: LoadedDocument,
    value: unknown,
    pointer: string,
    base: string,
    owned: boolean,
  ): void {
    let here = base
    let ours = owned
    if (isRecord(value)) {
      const id = resourceBase(document, value, base)
      if (id !== undefined) {
        here = id
        document.bases.set(pointer, here)
        this.claim(this.resources, here, { document, pointer, value, base: here })
        ours = this.owns(here, document, pointer)
      }
      for (const key of ["$anchor", "$dynamicAnchor"]) {
        const anchor = value[key]
        if (ours && typeof anchor === "string") {
          this.claim(this.anchors, `${here}#${anchor}`, { document, pointer, value, base: here })
        }
      }
    }
    this.indexChildren(document, value, pointer, here, ours)
  }

  /** Index what an array or object holds, but extensions and instance data; `map` names a name map. */
  private indexChildren(
    document: LoadedDocument,
    value: unknown,
    pointer: string,
    base: string,
    owned: boolean,
    map?: string,
  ): void {
    if (Array.isArray(value)) {
      value.forEach((item, i) =>
        this.indexResources(document, item, appendPointer(pointer, i), base, owned),
      )
      return
    }
    if (!isRecord(value)) return
    for (const [key, child] of Object.entries(value)) {
      const at = appendPointer(pointer, key)
      const extension = key.startsWith("x-") && (map === undefined || EXTENSIBLE_MAPS.has(map))
      if (extension || (map === undefined && NO_SCHEMAS.has(key))) {
        document.excluded.set(at, { value: child, base, owned })
        continue
      }
      if (map === undefined && NAME_MAPS.has(key)) {
        this.indexChildren(document, child, at, base, owned, key)
      } else this.indexResources(document, child, at, base, owned)
    }
  }

  /** Whether the resource at `uri` is the one at `pointer` in `document`. */
  private owns(uri: string, document: LoadedDocument, pointer: string): boolean {
    const owner = this.resources.get(uri)
    return owner?.document === document && owner.pointer === pointer
  }

  private claim(map: Map<string, DocumentNode>, uri: string, node: DocumentNode): void {
    if (!map.has(uri)) map.set(uri, node)
  }
}

/**
 * Load the entry document of a description: a path, a URL, or a parsed object. Problems go to
 * `diagnostics`, and the result is then `undefined`.
 */
export async function loadDocuments(
  input: string | URL | object,
  base: string | URL | undefined,
  diagnostics: Diagnostics,
  reader: DocumentReader,
): Promise<DocumentSet | undefined> {
  let uri: string
  let root: unknown
  let remote = false
  if (typeof input === "string" || input instanceof URL) {
    uri = sourceUri(input)
    try {
      const fetched = await reader.read(uri)
      uri = fetched.uri
      root = fetched.root
      remote = !isFileUri(uri)
    } catch (error) {
      reader.throwIfAborted()
      diagnostics.error("read-failed", `Cannot read ${uri}: ${errorMessage(error)}`, "#")
      return undefined
    }
  } else {
    uri = base === undefined ? MEMORY_URI : sourceUri(base)
    root = input
    remote = /^https?:/i.test(uri)
  }

  if (!isRecord(root)) {
    diagnostics.error("invalid-document", "An OpenAPI document must be a JSON object", "#")
    return undefined
  }
  try {
    assertAcyclic(root)
  } catch (error) {
    diagnostics.error("invalid-document", `Not a JSON document: ${errorMessage(error)}`, "#")
    return undefined
  }
  if (root.openapi === undefined && root.swagger !== undefined) {
    diagnostics.error(
      "unsupported-version",
      `Swagger ${String(root.swagger)} is not supported; convert the document to OpenAPI 3.x first`,
      "#/swagger",
    )
    return undefined
  }
  const version = parseOpenApiVersion(root.openapi)
  if (version === undefined) {
    const found = root.openapi === undefined ? "no `openapi` field" : `"${String(root.openapi)}"`
    diagnostics.error(
      "unsupported-version",
      `Expected OpenAPI 3.0.x, 3.1.x, or 3.2.x, found ${found}`,
      "#/openapi",
    )
    return undefined
  }
  const inMemory = typeof input !== "string" && !(input instanceof URL)
  return new DocumentSet(
    createDocument(uri, root, version, remote),
    !inMemory || base !== undefined,
    reader,
  )
}

function createDocument(
  uri: string,
  root: unknown,
  version: OpenApiVersion,
  remote: boolean,
): LoadedDocument {
  let base = uri
  if (version === "3.2" && isRecord(root) && typeof root.$self === "string") {
    const self = withoutFragment(resolveUri(root.$self, uri) ?? uri)
    // A remote document cannot pose as a local file.
    if (!(remote && isFileUri(self))) base = self
  }
  return { uri, base, root, version, remote, bases: new Map(), excluded: new Map() }
}

/**
 * The base URI the `$id` of `value` sets, where it starts a resource: not where a remote document
 * would pose as a local file, nor where it names the resource it is in (a bare fragment).
 */
function resourceBase(
  document: LoadedDocument,
  value: Record<string, unknown>,
  base: string,
): string | undefined {
  if (typeof value.$id !== "string") return undefined
  const id = resolveUri(value.$id, base)
  if (id === undefined || (document.remote && isFileUri(id))) return undefined
  const uri = withoutFragment(id)
  return uri === base ? undefined : uri
}

function isFileUri(uri: string): boolean {
  return /^file:/i.test(uri)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
