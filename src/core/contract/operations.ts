import type { Doc, Node } from "../openapi/documents"
import { resolveUri } from "../openapi/documents"
import { classifyMediaType } from "../shared/media"
import { isRecord } from "../shared/object"
import { union } from "./algebra"
import { mediaContentType } from "./content"
import { mergeDocs, objectDocs, schemaDocs } from "./docs"
import type {
  Body,
  Docs,
  Encoding,
  Field,
  Media,
  Operation,
  Response,
  SecurityRequirement,
  Type,
} from "./model"
import { UNDEFINED, UNKNOWN } from "./model"
import { identity } from "./nodes"
import type { Resolved } from "./references"
import { resolveObject } from "./references"
import type { SchemaBuilder } from "./schema"

const METHODS_30 = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]
const METHODS_32 = [...METHODS_30, "query"]
const LOCATIONS = new Set(["path", "query", "header", "cookie"])
// "SHALL be ignored" (all versions, Parameter Object `name`).
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"])

type Kind = "endpoint" | "webhook" | "callback"
type Location = "path" | "query" | "header" | "cookie"

const DEFAULT_STYLE: Record<Location, string> = {
  path: "simple",
  query: "form",
  header: "simple",
  cookie: "form",
}
// `deepObject` is defined for explode: true only.
const EXPLODED_BY_DEFAULT = new Set(["form", "cookie", "deepObject"])

export interface Operations {
  endpoints: Operation[]
  webhooks: Operation[]
  callbacks: Operation[]
}

/** Every operation under `paths`, `webhooks`, and (recursively) `callbacks`, in document order. */
export function buildOperations(builder: SchemaBuilder): Operations {
  const out: Operations = { endpoints: [], webhooks: [], callbacks: [] }
  const ops = new OperationBuilder(builder, out)
  const root = builder.docs.root(builder.docs.entry)
  const paths = builder.docs.child(root, "paths")
  if (isRecord(paths.value)) {
    for (const path of Object.keys(paths.value)) {
      // The Paths Object allows specification extensions beside its paths.
      if (path.startsWith("x-")) continue
      ops.pathItem(builder.docs.child(paths, path), "endpoint", path, "", new Set())
    }
  }
  const webhooks = builder.docs.child(root, "webhooks")
  if (isRecord(webhooks.value)) {
    if (builder.docs.entry.version === "3.0") {
      builder.warn(
        "lenient-keyword",
        '"webhooks" requires OpenAPI 3.1 or later; applied anyway',
        root,
        "webhooks",
      )
    }
    for (const name of Object.keys(webhooks.value)) {
      ops.pathItem(builder.docs.child(webhooks, name), "webhook", name, "", new Set())
    }
  }
  return out
}

class OperationBuilder {
  constructor(
    private readonly b: SchemaBuilder,
    private readonly out: Operations,
  ) {}

  pathItem(node: Node, kind: Kind, label: string, keyPrefix: string, callbacks: Set<string>): void {
    const fields = this.pathItemFields(node)
    if (fields === undefined) return
    const version = node.doc.version
    const methods: Array<[method: string, node: Node]> = []
    for (const method of METHODS_32) {
      const op = fields.get(method)
      if (op !== undefined) methods.push([method.toUpperCase(), op])
    }
    if (version !== "3.2") {
      for (const field of ["query", "additionalOperations"]) {
        const at = fields.get(field)
        if (at !== undefined) {
          this.b.warn("lenient-keyword", `"${field}" requires OpenAPI 3.2; applied anyway`, at)
        }
      }
    }
    const additional = fields.get("additionalOperations")
    if (additional !== undefined && isRecord(additional.value)) {
      for (const method of Object.keys(additional.value)) {
        const at = this.b.docs.child(additional, method)
        if (METHODS_32.includes(method.toLowerCase())) {
          this.b.warn(
            "ignored-keyword",
            `additionalOperations cannot redefine ${method}; use the "${method.toLowerCase()}" field`,
            at,
          )
          continue
        }
        methods.push([method, at])
      }
    }
    const shared = fields.get("parameters")
    const servers = fields.get("servers")
    for (const [method, op] of methods) {
      this.operation(op, method, label, kind, keyPrefix, shared, servers, callbacks)
    }
  }

  /** A Path Item's fields, merging a `$ref`'d Path Item with local fields (local wins). */
  private pathItemFields(node: Node): Map<string, Node> | undefined {
    const fields = new Map<string, Node>()
    if (!isRecord(node.value)) return fields
    if (typeof node.value.$ref === "string") {
      const resolved = resolveObject(this.b, node)
      if (resolved === undefined) return undefined
      const target = this.pathItemFields(resolved.node)
      if (target === undefined) return undefined
      for (const [key, value] of target) fields.set(key, value)
    }
    for (const key of Object.keys(node.value)) {
      if (key === "$ref") continue
      if (fields.has(key)) {
        this.b.warn(
          "path-item-conflict",
          `"${key}" is defined both here and in the referenced Path Item; the local definition is used`,
          node,
          key,
        )
      }
      fields.set(key, this.b.docs.child(node, key))
    }
    return fields
  }

  private operation(
    node: Node,
    method: string,
    label: string,
    kind: Kind,
    keyPrefix: string,
    shared: Node | undefined,
    servers: Node | undefined,
    callbacks: Set<string>,
  ): void {
    const op = node.value
    if (!isRecord(op)) return
    const key = `${keyPrefix}${method} ${label}`
    const params = this.parameters(shared, this.b.docs.child(node, "parameters"))

    const operation: Operation = {
      key,
      params: this.pathParams(params.path, kind, label, node),
      query: params.query,
      headers: params.header,
      cookies: params.cookie,
      // Your handler writes webhook and callback responses: they are typed as
      // request bodies are.
      responses: this.responses(this.b.docs.child(node, "responses"), kind !== "endpoint"),
    }
    if (params.querystring) operation.querystring = params.querystring
    const tags: Array<[string, string]> = []
    if (typeof op.operationId === "string") tags.push(["operationId", op.operationId])
    const docs = objectDocs(op, tags)
    if (docs) operation.docs = docs

    if ("requestBody" in op) {
      const body = this.body(this.b.docs.child(node, "requestBody"))
      if (body) operation.body = body
      // 3.0 says consumers SHALL ignore these; the APIs that declare them accept them.
      if (body && node.doc.version === "3.0" && ["GET", "HEAD", "DELETE"].includes(method)) {
        this.b.warn(
          "lenient-request-body",
          `OpenAPI 3.0 says to ignore requestBody on ${method}; it is kept as declared`,
          node,
          "requestBody",
        )
      }
    }

    if (kind === "endpoint") {
      const requires = requirements(this.b, this.b.docs.child(node, "security"))
      if (requires) operation.requires = requires
      const urls =
        serverUrls(this.b, this.b.docs.child(node, "servers")) ?? serverUrls(this.b, servers)
      if (urls) operation.servers = urls
    }

    const list =
      kind === "endpoint"
        ? this.out.endpoints
        : kind === "webhook"
          ? this.out.webhooks
          : this.out.callbacks
    list.push(operation)

    const callbackMap = this.b.docs.child(node, "callbacks")
    if (isRecord(callbackMap.value)) {
      for (const name of Object.keys(callbackMap.value)) {
        const resolved = resolveObject(this.b, this.b.docs.child(callbackMap, name))
        if (resolved === undefined || !isRecord(resolved.node.value)) continue
        // A callback that reappears within its own chain (via $ref) would expand forever.
        const id = identity(resolved.node)
        if (callbacks.has(id)) continue
        const chain = new Set(callbacks).add(id)
        for (const expression of Object.keys(resolved.node.value)) {
          if (expression.startsWith("x-")) continue
          this.pathItem(
            this.b.docs.child(resolved.node, expression),
            "callback",
            expression,
            `${key} > ${name} > `,
            chain,
          )
        }
      }
    }
  }

  private parameters(shared: Node | undefined, own: Node) {
    const byKey = new Map<string, { at: Resolved; value: Record<string, unknown> }>()
    for (const list of [shared, own]) {
      if (list === undefined || !Array.isArray(list.value)) continue
      const local = new Set<string>()
      list.value.forEach((_, i) => {
        const at = resolveObject(this.b, this.b.docs.child(list, i))
        if (at === undefined) return
        const value = at.node.value
        if (!isRecord(value) || typeof value.name !== "string" || typeof value.in !== "string") {
          this.b.warn(
            "invalid-parameter",
            'A parameter needs string "name" and "in" fields',
            at.node,
          )
          return
        }
        const location = value.in
        if (location === "querystring" && at.node.doc.version !== "3.2") {
          this.b.warn(
            "lenient-keyword",
            '"in: querystring" requires OpenAPI 3.2; applied anyway',
            at.node,
            "in",
          )
        } else if (!LOCATIONS.has(location) && location !== "querystring") {
          this.b.warn(
            "invalid-parameter",
            `Unknown parameter location "${location}"`,
            at.node,
            "in",
          )
          return
        }
        if (location === "header" && IGNORED_HEADERS.has(value.name.toLowerCase())) return
        // Header names are case-insensitive; other parameter names are not.
        const key = `${location}:${location === "header" ? value.name.toLowerCase() : value.name}`
        if (local.has(key)) {
          this.b.warn(
            "invalid-parameter",
            `Duplicate ${location} parameter "${value.name}"`,
            at.node,
          )
        }
        local.add(key)
        byKey.set(key, { at, value })
      })
    }

    const out = {
      path: [] as Field[],
      query: [] as Field[],
      header: [] as Field[],
      cookie: [] as Field[],
      querystring: undefined as Operation["querystring"],
    }
    for (const { at, value } of byKey.values()) {
      const field = this.parameterField(at, value)
      const location = value.in as string
      if (location === "querystring") {
        if (out.querystring) {
          this.b.warn("invalid-parameter", "Only one querystring parameter is allowed", at.node)
          continue
        }
        out.querystring = { type: field.type, required: field.required }
        if (field.docs) out.querystring.docs = field.docs
        const [mediaType] = isRecord(value.content) ? Object.keys(value.content) : []
        if (mediaType !== undefined && classifyMediaType(mediaType) !== "form") {
          out.querystring.mediaType = mediaType
        } else if (mediaType !== undefined) {
          // Form fields serialize like query parameters, by their Encoding Objects.
          const [media] = this.content(this.b.docs.child(at.node, "content"), true)
          if (media?.encoding) out.querystring.encoding = media.encoding
        }
      } else {
        const encoding = encodingOf(value, DEFAULT_STYLE[location as Location])
        if (encoding) field.encoding = encoding
        out[location as Location].push(field)
      }
    }
    if (out.querystring && out.query.length > 0) {
      this.b.warn(
        "invalid-parameter",
        "A querystring parameter cannot be combined with query parameters; the query parameters are ignored",
        own,
      )
      out.query = []
    }
    return out
  }

  private parameterField(at: Resolved, value: Record<string, unknown>): Field {
    const node = at.node
    const field: Field = {
      name: value.name as string,
      type: this.valueType(node, value, "parameter"),
      required: value.in === "path" || value.required === true,
    }
    if (value.in === "path" && value.required !== true) {
      this.b.warn(
        "invalid-parameter",
        'Path parameters must have "required: true"; treated as required',
        node,
      )
    }
    const docs = this.valueDocs(at, value)
    if (docs) field.docs = docs
    return field
  }

  /** Type of a Parameter or Header Object: its `schema`, or its single `content` entry. */
  private valueType(node: Node, value: Record<string, unknown>, what: string): Type {
    const hasSchema = "schema" in value
    const content = isRecord(value.content) ? Object.keys(value.content) : []
    if (hasSchema && content.length > 0) {
      this.b.warn(
        "invalid-parameter",
        `A ${what} cannot have both "schema" and "content"; "schema" is used`,
        node,
      )
    }
    if (hasSchema) return this.b.type(this.b.docs.child(node, "schema"))
    if (content.length > 0) {
      if (content.length > 1) {
        this.b.warn(
          "invalid-parameter",
          `A ${what}'s "content" must have exactly one entry; the first is used`,
          node,
          "content",
        )
      }
      const media = resolveObject(this.b, this.b.docs.child(node, "content", content[0]))
      return media === undefined
        ? UNKNOWN
        : // The 3.2 querystring is the whole query, encoded like a request body.
          mediaContentType(
            this.b,
            media.node,
            content[0],
            value.in === "querystring" ? "request" : "parameter",
          )
    }
    this.b.warn("invalid-parameter", `A ${what} needs "schema" or "content"`, node)
    return UNKNOWN
  }

  private valueDocs(at: Resolved, value: Record<string, unknown>): Docs | undefined {
    const own = objectDocs({
      ...value,
      summary: undefined,
      description: at.description ?? value.description,
    })
    return mergeDocs(
      own,
      "schema" in value ? schemaDocs(this.b.docs.child(at.node, "schema")) : undefined,
    )
  }

  /** Path parameters must match the path template one-to-one (endpoints only). */
  private pathParams(declared: Field[], kind: Kind, label: string, node: Node): Field[] {
    if (kind === "callback") return declared
    if (kind === "webhook") {
      if (declared.length > 0) {
        this.b.warn(
          "path-parameter-mismatch",
          "Webhooks have no path template; path parameters are ignored",
          node,
        )
      }
      return []
    }
    const template = [...label.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1])
    const out = declared.filter((field) => {
      if (template.includes(field.name)) return true
      this.b.warn(
        "path-parameter-mismatch",
        `Path parameter "${field.name}" does not appear in ${label} and is ignored`,
        node,
      )
      return false
    })
    for (const name of template) {
      if (out.some((field) => field.name === name)) continue
      this.b.warn(
        "path-parameter-mismatch",
        `{${name}} in ${label} has no path parameter; it is typed as string`,
        node,
      )
      out.push({ name, type: { kind: "string" }, required: true })
    }
    // Template order reads naturally and matches the URL.
    return out.toSorted((a, b) => template.indexOf(a.name) - template.indexOf(b.name))
  }

  private body(node: Node): Body | undefined {
    const resolved = resolveObject(this.b, node)
    if (resolved === undefined || !isRecord(resolved.node.value)) return undefined
    const content = this.content(this.b.docs.child(resolved.node, "content"), true)
    if (content.length === 0) return undefined
    const body: Body = { required: resolved.node.value.required === true, content }
    const docs = objectDocs({
      description: resolved.description ?? resolved.node.value.description,
    })
    if (docs) body.docs = docs
    return body
  }

  /** Media types and their types; for a request, also form and multipart Encoding Objects. */
  private content(node: Node, request = false): Media[] {
    if (!isRecord(node.value)) return []
    return Object.keys(node.value).flatMap((mediaType) => {
      const media = resolveObject(this.b, this.b.docs.child(node, mediaType))
      if (media === undefined) return []
      const out: Media = {
        mediaType,
        type: mediaContentType(this.b, media.node, mediaType, request ? "request" : "response"),
      }
      const kind = classifyMediaType(mediaType)
      const encoding = isRecord(media.node.value) ? media.node.value.encoding : undefined
      if (request && (kind === "form" || kind === "multipart") && isRecord(encoding)) {
        const parsed = Object.entries(encoding).flatMap(([property, value]) => {
          const spec = isRecord(value) ? encodingOf(value, "form", kind) : undefined
          return spec ? [[property, spec]] : []
        })
        if (parsed.length > 0) out.encoding = Object.fromEntries(parsed)
      }
      return [out]
    })
  }

  private responses(node: Node, written: boolean): Response[] {
    if (!isRecord(node.value)) return []
    const out: Response[] = []
    for (const key of Object.keys(node.value)) {
      if (key.startsWith("x-")) continue
      const status = this.statusKey(key, node)
      const resolved = resolveObject(this.b, this.b.docs.child(node, key))
      if (resolved === undefined || !isRecord(resolved.node.value)) continue
      const value = resolved.node.value
      const content = this.content(this.b.docs.child(resolved.node, "content"), written)
      const response: Response = {
        status,
        type: content.length === 0 ? UNDEFINED : union(content.map((m) => m.type)),
        headers: this.responseHeaders(this.b.docs.child(resolved.node, "headers")),
      }
      const docs = objectDocs({
        summary: resolved.summary ?? value.summary,
        description: resolved.description ?? value.description,
      })
      if (docs) response.docs = docs
      const same = out.find((r) => r.status === status)
      if (same) {
        // `2xx` and `2XX` describe the same responses.
        same.type = union([same.type, response.type])
        continue
      }
      out.push(response)
    }
    return out
  }

  private statusKey(key: string, at: Node): string {
    if (key === "default" || /^[1-5](\d\d|XX)$/.test(key)) return key
    if (/^[1-5]xx$/i.test(key)) {
      this.b.warn("invalid-status-code", `Status range "${key}" must use uppercase X`, at, key)
      return key.toUpperCase()
    }
    this.b.warn(
      "invalid-status-code",
      `"${key}" is not an HTTP status code, range, or "default"`,
      at,
      key,
    )
    return key
  }

  private responseHeaders(node: Node): Field[] {
    if (!isRecord(node.value)) return []
    const fields: Field[] = []
    for (const name of Object.keys(node.value)) {
      // "If a response header is defined with the name "Content-Type", it SHALL be ignored."
      if (name.toLowerCase() === "content-type") continue
      const at = resolveObject(this.b, this.b.docs.child(node, name))
      if (at === undefined || !isRecord(at.node.value)) continue
      const value = at.node.value
      const field: Field = {
        name,
        type: this.valueType(at.node, value, "header"),
        required: value.required === true,
      }
      const docs = this.valueDocs(at, value)
      if (docs) field.docs = docs
      fields.push(field)
    }
    return fields
  }
}

/**
 * A parameter's or Encoding Object's serialization, where it differs from the
 * default: then always with its style and explode, so it reads on its own.
 */
function encodingOf(
  value: Record<string, unknown>,
  defaultStyle: string,
  /** For an Encoding Object: the body it belongs to. */
  body?: "form" | "multipart",
): Encoding | undefined {
  // A parameter with `content` is serialized as that media type; style does not apply.
  if (body === undefined && isRecord(value.content)) {
    const [mediaType] = Object.keys(value.content)
    return mediaType === undefined ? undefined : { contentType: mediaType }
  }
  const out: Encoding = {}
  const style = typeof value.style === "string" ? value.style : defaultStyle
  const explode =
    typeof value.explode === "boolean" ? value.explode : EXPLODED_BY_DEFAULT.has(style)
  const allowReserved = value.allowReserved === true
  if (
    style !== defaultStyle ||
    explode !== EXPLODED_BY_DEFAULT.has(defaultStyle) ||
    allowReserved
  ) {
    out.style = style
    out.explode = explode
    if (allowReserved) out.allowReserved = true
  }
  // An Encoding Object's contentType: a multipart part's media type, or how a
  // form field is encoded unless style, explode, or allowReserved says otherwise.
  if (
    body !== undefined &&
    typeof value.contentType === "string" &&
    (body === "multipart" || !("style" in value || "explode" in value || "allowReserved" in value))
  ) {
    out.contentType = value.contentType
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Security Requirement Objects; `{}` admits anonymous access. Malformed ones are reported. */
export function requirements(b: SchemaBuilder, node: Node): SecurityRequirement[] | undefined {
  const value = node.value
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    b.warn("invalid-security", "Security requirements must be an array; these are ignored", node)
    return undefined
  }
  const root = b.docs.root(b.docs.entry)
  const schemes = b.docs.child(root, "components", "securitySchemes").value
  return value.flatMap((requirement: unknown, i) => {
    const at = b.docs.child(node, i)
    if (!isRecord(requirement)) {
      b.warn("invalid-security", "A security requirement must be an object; it is ignored", at)
      return []
    }
    for (const name of Object.keys(requirement)) {
      if (!isRecord(schemes) || !Object.hasOwn(schemes, name)) {
        b.warn(
          "invalid-security",
          `"${name}" is not a declared security scheme, so this requirement cannot be met`,
          at,
          name,
        )
      }
    }
    return [
      Object.fromEntries(
        Object.entries(requirement).map(([name, scopes]) => [
          name,
          Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [],
        ]),
      ),
    ]
  })
}

/**
 * Server Object URLs, variables filled with their defaults; `undefined` when
 * none are declared. A document fetched over HTTP(S) defaults to its own origin.
 */
export function serverUrls(b: SchemaBuilder, node: Node | undefined): string[] | undefined {
  if (node === undefined || !Array.isArray(node.value)) return undefined
  const urls = node.value.flatMap((server: unknown, i) => {
    if (!isRecord(server) || typeof server.url !== "string") return []
    const at = b.docs.child(node, i)
    const variables = isRecord(server.variables) ? server.variables : {}
    const url = server.url.replaceAll(/\{([^{}]+)\}/g, (match, name: string) => {
      const variable = variables[name]
      const value = isRecord(variable) ? variable.default : undefined
      if (typeof value === "string") return value
      if (typeof value === "number" || typeof value === "boolean") {
        b.warn(
          "invalid-server",
          `Server variable "${name}" has a non-string default; used as written`,
          at,
        )
        return String(value)
      }
      b.warn(
        "invalid-server",
        `Server variable "${name}" has no default; pass the URL as the client's server option`,
        at,
      )
      return match
    })
    return [relativeTo(url, node.doc)]
  })
  return urls.length > 0 ? urls : undefined
}

/** The servers a document has without `servers`: its own location, when fetched over HTTP(S). */
export function implicitServers(doc: Doc): string[] {
  return /^https?:/i.test(doc.uri) ? [relativeTo("/", doc)] : []
}

/** A relative server URL is relative to where the document was retrieved. */
function relativeTo(url: string, doc: Doc): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || !/^https?:/i.test(doc.uri)) return url
  return (resolveUri(url, doc.uri) ?? url).replace(/\/$/, "")
}
