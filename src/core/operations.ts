import { mergeAnnotations, objectAnnotations, schemaAnnotations } from "./annotations"
import type { BuildContext } from "./build-context"
import { typeOfContent } from "./content"
import { identity } from "./document-nodes"
import type { DocumentNode } from "./documents"
import { formContentTypes } from "./form-encoding"
import { classifyMediaType, isFormData } from "./media-types"
import type { Body, Annotations, Encoding, Field, Media, Operation, Response, Type } from "./model"
import { UNKNOWN } from "./model"
import { isRecord } from "./object"
import type { Resolved } from "./references"
import { resolveObject } from "./references"
import type { SchemaBuilder } from "./schemas"
import { union } from "./type-algebra"

const METHODS_30 = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]
const METHODS_32 = [...METHODS_30, "query"]
const LOCATIONS = new Set(["path", "query", "header", "cookie"])
// "SHALL be ignored" (all versions, Parameter Object `name`).
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"])

type Kind = "endpoint" | "webhook" | "callback"
type Location = "path" | "query" | "header" | "cookie"
/** The locations the client sends parameters in, and so encodes them for. */
type Sent = Exclude<Location, "cookie">

const DEFAULT_STYLE: Record<Sent, string> = {
  path: "simple",
  query: "form",
  header: "simple",
}
// `deepObject` is defined for explode: true only.
const EXPLODED_BY_DEFAULT = new Set(["form", "cookie", "deepObject"])
// The styles a form field serializes in, which the client applies to multipart fields too.
const FIELD_STYLES = new Set(["form", "spaceDelimited", "pipeDelimited", "deepObject"])

export interface Operations {
  endpoints: Operation[]
  webhooks: Operation[]
  callbacks: Operation[]
}

/** Every operation under `paths`, `webhooks`, and (recursively) `callbacks`, in document order. */
export function buildOperations(context: BuildContext, schemas: SchemaBuilder): Operations {
  const out: Operations = { endpoints: [], webhooks: [], callbacks: [] }
  const ops = new OperationBuilder(context, schemas, out)
  const root = context.documents.root(context.documents.entry)
  const paths = context.documents.child(root, "paths")
  if (isRecord(paths.value)) {
    for (const path of Object.keys(paths.value)) {
      // The Paths Object allows specification extensions beside its paths.
      if (path.startsWith("x-")) continue
      ops.pathItem(context.documents.child(paths, path), "endpoint", path, "", new Set())
    }
  }
  const webhooks = context.documents.child(root, "webhooks")
  // A 3.1 field, applied in 3.0 too.
  if (isRecord(webhooks.value)) {
    for (const name of Object.keys(webhooks.value)) {
      ops.pathItem(context.documents.child(webhooks, name), "webhook", name, "", new Set())
    }
  }
  return out
}

class OperationBuilder {
  constructor(
    private readonly context: BuildContext,
    private readonly schemas: SchemaBuilder,
    private readonly out: Operations,
  ) {}

  pathItem(
    node: DocumentNode,
    kind: Kind,
    label: string,
    keyPrefix: string,
    callbacks: Set<string>,
  ): void {
    const fields = this.pathItemFields(node)
    if (fields === undefined) return
    // `query` and `additionalOperations` are 3.2 fields, applied in earlier versions too.
    const methods: Array<[method: string, node: DocumentNode]> = []
    for (const method of METHODS_32) {
      const op = fields.get(method)
      if (op !== undefined) methods.push([method.toUpperCase(), op])
    }
    const additional = fields.get("additionalOperations")
    if (additional !== undefined && isRecord(additional.value)) {
      for (const method of Object.keys(additional.value)) {
        const at = this.context.documents.child(additional, method)
        if (METHODS_32.includes(method.toLowerCase())) {
          this.context.warn(
            "ignored-field",
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
  private pathItemFields(node: DocumentNode): Map<string, DocumentNode> | undefined {
    const fields = new Map<string, DocumentNode>()
    const chain: DocumentNode[] = []
    const seen = new Set<string>()
    let current = node
    while (isRecord(current.value)) {
      const id = identity(current)
      if (seen.has(id)) {
        this.context.error("circular-ref", "Reference cycle through a Path Item", node, "$ref")
        return undefined
      }
      seen.add(id)
      chain.push(current)
      const ref = current.value.$ref
      if (typeof ref !== "string") break
      const resolution = this.context.documents.resolve(ref, current)
      if (resolution.kind === "pending") return undefined
      if (resolution.kind === "error") {
        this.context.error(
          "unresolved-ref",
          `Cannot resolve $ref "${ref}": ${resolution.message}`,
          current,
          "$ref",
        )
        return undefined
      }
      current = resolution.node
    }
    // Start at the target so each referring Path Item overrides its inherited fields.
    for (const link of chain.toReversed()) {
      for (const key of Object.keys(link.value as Record<string, unknown>)) {
        if (key === "$ref") continue
        if (fields.has(key)) {
          this.context.warn(
            "path-item-conflict",
            `"${key}" is defined both here and in the referenced Path Item; the local definition is used`,
            link,
            key,
          )
        }
        fields.set(key, this.context.documents.child(link, key))
      }
    }
    return fields
  }

  private operation(
    node: DocumentNode,
    method: string,
    label: string,
    kind: Kind,
    keyPrefix: string,
    shared: DocumentNode | undefined,
    servers: DocumentNode | undefined,
    callbacks: Set<string>,
  ): void {
    const op = node.value
    if (!isRecord(op)) return
    const key = `${keyPrefix}${method} ${label}`
    const params = this.parameters(shared, this.context.documents.child(node, "parameters"))

    const operation: Operation = {
      key,
      params: this.pathParams(params.path, kind, label, node),
      query: params.query,
      headers: params.header,
      cookies: params.cookie,
      responses: this.responses(this.context.documents.child(node, "responses")),
    }
    if (params.querystring) operation.querystring = params.querystring
    const tags: Array<[string, string]> = []
    if (typeof op.operationId === "string") tags.push(["operationId", op.operationId])
    const annotations = objectAnnotations(op, tags)
    if (annotations) operation.annotations = annotations

    if ("requestBody" in op) {
      const body = this.body(this.context.documents.child(node, "requestBody"))
      // Kept on GET, HEAD, and DELETE too, which 3.0 says to ignore: the APIs
      // that declare them accept them.
      if (body) operation.body = body
    }

    if (kind === "endpoint") {
      for (const at of [this.context.documents.child(node, "servers"), servers]) {
        if (!Array.isArray(at?.value) || at.value.length === 0) continue
        this.context.warn(
          "ignored-field",
          "Servers of a path or operation are not applied: the client sends every request to its baseUrl; use a second client for these operations",
          at,
        )
      }
    }

    const list =
      kind === "endpoint"
        ? this.out.endpoints
        : kind === "webhook"
          ? this.out.webhooks
          : this.out.callbacks
    list.push(operation)

    const callbackMap = this.context.documents.child(node, "callbacks")
    if (isRecord(callbackMap.value)) {
      for (const name of Object.keys(callbackMap.value)) {
        const resolved = resolveObject(
          this.context,
          this.context.documents.child(callbackMap, name),
        )
        if (resolved === undefined || !isRecord(resolved.node.value)) continue
        // A callback that reappears within its own chain (via $ref) would expand forever.
        const id = identity(resolved.node)
        if (callbacks.has(id)) continue
        const chain = new Set(callbacks).add(id)
        for (const expression of Object.keys(resolved.node.value)) {
          if (expression.startsWith("x-")) continue
          this.pathItem(
            this.context.documents.child(resolved.node, expression),
            "callback",
            expression,
            `${key} > ${name} > `,
            chain,
          )
        }
      }
    }
  }

  private parameters(shared: DocumentNode | undefined, own: DocumentNode) {
    const byKey = new Map<string, { at: Resolved; value: Record<string, unknown> }>()
    for (const list of [shared, own]) {
      if (list === undefined || !Array.isArray(list.value)) continue
      const local = new Set<string>()
      list.value.forEach((_, i) => {
        const at = resolveObject(this.context, this.context.documents.child(list, i))
        if (at === undefined) return
        const value = at.node.value
        if (!isRecord(value) || typeof value.name !== "string" || typeof value.in !== "string") {
          this.context.warn(
            "invalid-parameter",
            'A parameter needs string "name" and "in" fields',
            at.node,
          )
          return
        }
        // `in: querystring` is 3.2's, applied in earlier versions too.
        const location = value.in
        if (!LOCATIONS.has(location) && location !== "querystring") {
          this.context.warn(
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
          this.context.warn(
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
          this.context.warn(
            "invalid-parameter",
            "Only one querystring parameter is allowed",
            at.node,
          )
          continue
        }
        out.querystring = { type: field.type, required: field.required, location: field.location }
        if (field.annotations) out.querystring.annotations = field.annotations
        const [mediaType] = isRecord(value.content) ? Object.keys(value.content) : []
        if (mediaType !== undefined && classifyMediaType(mediaType) !== "form") {
          out.querystring.mediaType = mediaType
        } else if (mediaType !== undefined) {
          // Form fields serialize like query parameters, by their Encoding Objects.
          const media = resolveObject(
            this.context,
            this.context.documents.child(at.node, "content", mediaType),
          )
          const encoding = media && this.formEncoding(media.node, false)
          if (encoding) out.querystring.encoding = encoding
        }
      } else {
        // Cookies are the runtime's to send, so their encodings go unused.
        const encoding =
          location === "cookie" ? undefined : encodingOf(value, DEFAULT_STYLE[location as Sent])
        if (encoding) field.encoding = encoding
        out[location as Location].push(field)
      }
    }
    if (out.querystring && out.query.length > 0) {
      this.context.warn(
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
      location: this.context.documents.locate(node.document, node.pointer),
    }
    if (value.in === "path" && value.required !== true) {
      this.context.warn(
        "invalid-parameter",
        'Path parameters must have "required: true"; treated as required',
        node,
      )
    }
    const annotations = this.valueAnnotations(at, value)
    if (annotations) field.annotations = annotations
    return field
  }

  /** Type of a Parameter or Header Object: its `schema`, or its single `content` entry. */
  private valueType(node: DocumentNode, value: Record<string, unknown>, what: string): Type {
    const hasSchema = "schema" in value
    const content = isRecord(value.content) ? Object.keys(value.content) : []
    if (hasSchema && content.length > 0) {
      this.context.warn(
        "invalid-parameter",
        `A ${what} cannot have both "schema" and "content"; "schema" is used`,
        node,
      )
    }
    if (hasSchema) return this.schemas.type(this.context.documents.child(node, "schema"))
    if (content.length > 0) {
      if (content.length > 1) {
        this.context.warn(
          "invalid-parameter",
          `A ${what}'s "content" must have exactly one entry; the first is used`,
          node,
          "content",
        )
      }
      const media = resolveObject(
        this.context,
        this.context.documents.child(node, "content", content[0]),
      )
      return media === undefined
        ? UNKNOWN
        : // The 3.2 querystring is the whole query, encoded like a request body.
          typeOfContent(this.schemas, media.node, content[0], value.in !== "querystring")
    }
    this.context.warn("invalid-parameter", `A ${what} needs "schema" or "content"`, node)
    return UNKNOWN
  }

  private valueAnnotations(at: Resolved, value: Record<string, unknown>): Annotations | undefined {
    const own = objectAnnotations({
      ...value,
      summary: undefined,
      description: at.description ?? value.description,
    })
    return mergeAnnotations(
      own,
      "schema" in value
        ? schemaAnnotations(this.context.documents.child(at.node, "schema"))
        : undefined,
    )
  }

  /** Path parameters must match the path template one-to-one (endpoints only). */
  private pathParams(declared: Field[], kind: Kind, label: string, node: DocumentNode): Field[] {
    if (kind === "callback") return declared
    if (kind === "webhook") {
      if (declared.length > 0) {
        this.context.warn(
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
      this.context.warn(
        "path-parameter-mismatch",
        `Path parameter "${field.name}" does not appear in ${label} and is ignored`,
        node,
      )
      return false
    })
    for (const name of template) {
      if (out.some((field) => field.name === name)) continue
      this.context.warn(
        "path-parameter-mismatch",
        `{${name}} in ${label} has no path parameter; it is typed as string`,
        node,
      )
      out.push({ name, type: { kind: "string" }, required: true })
    }
    // Template order reads naturally and matches the URL.
    return out.toSorted((a, b) => template.indexOf(a.name) - template.indexOf(b.name))
  }

  private body(node: DocumentNode): Body | undefined {
    const resolved = resolveObject(this.context, node)
    if (resolved === undefined || !isRecord(resolved.node.value)) return undefined
    const content = this.content(this.context.documents.child(resolved.node, "content"), true)
    if (content.length === 0) return undefined
    const body: Body = { required: resolved.node.value.required === true, content }
    const annotations = objectAnnotations({
      description: resolved.description ?? resolved.node.value.description,
    })
    if (annotations) body.annotations = annotations
    return body
  }

  /** Media types and their types, with the Encoding Objects of form content. */
  private content(node: DocumentNode, request = false): Media[] {
    if (!isRecord(node.value)) return []
    return Object.keys(node.value).flatMap((mediaType) => {
      const media = resolveObject(this.context, this.context.documents.child(node, mediaType))
      if (media === undefined) return []
      const out: Media = {
        mediaType,
        type: typeOfContent(this.schemas, media.node, mediaType),
        location: this.context.documents.locate(media.node.document, media.node.pointer),
      }
      // The client encodes multipart fields only for requests, and only named ones (form-data).
      const multipart = request && isFormData(mediaType)
      if (multipart || (request && classifyMediaType(mediaType) === "form")) {
        const encoding = this.formEncoding(media.node, multipart)
        if (encoding) out.encoding = encoding
      }
      return [out]
    })
  }

  /** Explicit encodings and schema-derived defaults for each named form property. */
  private formEncoding(
    media: DocumentNode,
    multipart: boolean,
  ): Record<string, Encoding> | undefined {
    if (multipart) this.unapplied(media, ["prefixEncoding", "itemEncoding"])
    const node = this.context.documents.child(media, "encoding")
    const configured = isRecord(node.value) ? node.value : {}
    const entries = new Map<string, Encoding>()
    const styled = new Set<string>()
    for (const [property, value] of Object.entries(configured)) {
      if (!isRecord(value)) continue
      if (
        (!multipart || media.document.version !== "3.0") &&
        ("style" in value || "explode" in value || "allowReserved" in value)
      )
        styled.add(property)
      const spec = multipart
        ? this.partEncoding(this.context.documents.child(node, property), value)
        : encodingOf(value, "form", true)
      if (spec) entries.set(property, spec)
    }
    for (const [name, contentType] of formContentTypes(
      this.context,
      this.context.documents.child(media, "schema"),
    )) {
      if (styled.has(name) || entries.get(name)?.contentType !== undefined) continue
      if (contentType === undefined) {
        this.context.warn(
          "ignored-field",
          `Cannot determine one default contentType for form field "${name}"; specify encoding.contentType or an explicit style`,
          media,
          "schema",
        )
        continue
      }
      entries.set(name, { contentType })
    }
    if (!multipart) {
      for (const spec of entries.values()) if (spec.contentType !== undefined) spec.repeat = true
    }
    return entries.size > 0 ? Object.fromEntries(entries) : undefined
  }

  /**
   * A multipart field's encoding, without what FormData cannot send. An explicit style is kept even
   * at its default, since it overrides `contentType`.
   */
  private partEncoding(at: DocumentNode, value: Record<string, unknown>): Encoding | undefined {
    const nested = ["encoding", "prefixEncoding", "itemEncoding"]
    // A Content-Type header "SHALL be ignored" here; the field's contentType sets it.
    const headers =
      isRecord(value.headers) &&
      Object.keys(value.headers).some((name) => name.toLowerCase() !== "content-type")
    this.unapplied(at, headers ? ["headers", ...nested] : nested)
    // OpenAPI 3.0 applies style, explode, and allowReserved to URL-encoded forms only.
    const styled = at.document.version !== "3.0"
    if (styled && typeof value.style === "string" && !FIELD_STYLES.has(value.style)) {
      this.context.warn(
        "ignored-field",
        `Multipart style "${value.style}" is not supported; supply an already encoded body`,
        at,
        "style",
      )
      return undefined
    }
    const spec = encodingOf(styled ? value : { contentType: value.contentType }, "form", true, true)
    if (spec?.contentType !== undefined && !isConcreteMediaType(spec.contentType)) {
      this.context.warn(
        "ignored-field",
        "Multipart contentType must name one concrete media type for automatic encoding; use a Blob with the selected type or FormData",
        at,
        "contentType",
      )
      delete spec.contentType
    }
    return spec && Object.keys(spec).length > 0 ? spec : undefined
  }

  /** Report the fields of `node` among `keys`, which FormData cannot send. */
  private unapplied(node: DocumentNode, keys: string[]): void {
    if (!isRecord(node.value)) return
    for (const key of keys) {
      if (key in node.value) {
        this.context.warn(
          "ignored-field",
          `Multipart ${key} is not applied; supply an already encoded body for this configuration`,
          node,
          key,
        )
      }
    }
  }

  private responses(node: DocumentNode): Response[] {
    if (!isRecord(node.value)) return []
    const out: Response[] = []
    for (const key of Object.keys(node.value)) {
      if (key.startsWith("x-")) continue
      const status = this.statusKey(key, node)
      const resolved = resolveObject(this.context, this.context.documents.child(node, key))
      if (resolved === undefined || !isRecord(resolved.node.value)) continue
      const value = resolved.node.value
      const response: Response = {
        status,
        content: this.content(this.context.documents.child(resolved.node, "content")),
        headers: this.responseHeaders(this.context.documents.child(resolved.node, "headers")),
      }
      const annotations = objectAnnotations({
        summary: resolved.summary ?? value.summary,
        description: resolved.description ?? value.description,
      })
      if (annotations) response.annotations = annotations
      const same = out.find((r) => r.status === status)
      if (same) {
        // `2xx` and `2XX` describe the same responses.
        for (const media of response.content) {
          const existing = same.content.find((m) => m.mediaType === media.mediaType)
          if (existing) existing.type = union([existing.type, media.type])
          else same.content.push(media)
        }
        continue
      }
      out.push(response)
    }
    return out
  }

  private statusKey(key: string, at: DocumentNode): string {
    if (key === "default" || /^[1-5](\d\d|XX)$/.test(key)) return key
    // A range in lowercase means the same range.
    if (/^[1-5]xx$/i.test(key)) return key.toUpperCase()
    this.context.warn(
      "invalid-status-code",
      `"${key}" is not an HTTP status code, range, or "default"`,
      at,
      key,
    )
    return key
  }

  private responseHeaders(node: DocumentNode): Field[] {
    if (!isRecord(node.value)) return []
    const fields: Field[] = []
    for (const name of Object.keys(node.value)) {
      // "If a response header is defined with the name "Content-Type", it SHALL be ignored."
      if (name.toLowerCase() === "content-type") continue
      const at = resolveObject(this.context, this.context.documents.child(node, name))
      if (at === undefined || !isRecord(at.node.value)) continue
      const value = at.node.value
      const field: Field = {
        name,
        type: this.valueType(at.node, value, "header"),
        required: value.required === true,
      }
      const annotations = this.valueAnnotations(at, value)
      if (annotations) field.annotations = annotations
      fields.push(field)
    }
    return fields
  }
}

/** One media type without wildcards, not a list (a comma inside a quoted parameter aside). */
function isConcreteMediaType(mediaType: string): boolean {
  const essence = mediaType.split(";", 1)[0]
  return (
    essence.includes("/") &&
    !essence.includes("*") &&
    !mediaType.replaceAll(/"(?:[^"\\]|\\.)*"/g, "").includes(",")
  )
}

/**
 * A parameter's or Encoding Object's serialization, where it differs from the default: then always
 * with its style and explode, so it reads on its own.
 */
function encodingOf(
  value: Record<string, unknown>,
  defaultStyle: string,
  /** For an Encoding Object of a form body. */
  field = false,
  multipart = false,
): Encoding | undefined {
  // A parameter with `content` is serialized as that media type; style does not apply.
  if (!field && isRecord(value.content)) {
    const [mediaType] = Object.keys(value.content)
    return mediaType === undefined ? undefined : { contentType: mediaType }
  }
  const out: Encoding = {}
  const style = typeof value.style === "string" ? value.style : defaultStyle
  const explode =
    typeof value.explode === "boolean" ? value.explode : EXPLODED_BY_DEFAULT.has(style)
  const allowReserved = value.allowReserved === true
  if (
    (multipart && ("style" in value || "explode" in value || "allowReserved" in value)) ||
    style !== defaultStyle ||
    explode !== EXPLODED_BY_DEFAULT.has(defaultStyle) ||
    allowReserved
  ) {
    out.style = style
    out.explode = explode
    if (allowReserved) out.allowReserved = true
  }
  // A form field's contentType applies unless style, explode, or allowReserved says otherwise.
  if (
    field &&
    typeof value.contentType === "string" &&
    !("style" in value || "explode" in value || "allowReserved" in value)
  ) {
    out.contentType = value.contentType
  }
  return Object.keys(out).length > 0 ? out : undefined
}
