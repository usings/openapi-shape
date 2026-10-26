import { mergeAnnotations, objectAnnotations, schemaAnnotations } from "./annotations"
import type { BuildContext } from "./build-context"
import { typeOfContent } from "./content-types"
import type { DocumentNode } from "./documents"
import { encodingOf } from "./encoding"
import { formEncoding } from "./form-encoding"
import { classifyMediaType } from "./media-types"
import type { Annotations, Field, Operation, Type } from "./model"
import { UNKNOWN } from "./model"
import { isRecord } from "./object"
import { selectParameters } from "./operation-rules"
import type { Resolved } from "./references"
import { resolveObject } from "./references"
import type { SchemaBuilder } from "./schemas"

const LOCATIONS = new Set(["path", "query", "header", "cookie"])
// "SHALL be ignored" (all versions, Parameter Object `name`).
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"])

type Location = "path" | "query" | "header" | "cookie"
/** The locations the client sends parameters in, and so encodes them for. */
type Sent = Exclude<Location, "cookie">

const DEFAULT_STYLE: Record<Sent, string> = {
  path: "simple",
  query: "form",
  header: "simple",
}
/** Read request parameters and response headers with their schema and Reference Object annotations. */
export class ParameterBuilder {
  constructor(
    private readonly context: BuildContext,
    private readonly schemas: SchemaBuilder,
  ) {}

  parameters(shared: DocumentNode | undefined, own: DocumentNode) {
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
    const selected = new Set(selectParameters(byKey.values()))
    let ignoredQuery = false
    for (const parameter of byKey.values()) {
      const { at, value } = parameter
      if (!selected.has(parameter)) {
        if (value.in === "query") ignoredQuery = true
        else
          this.context.warn(
            "invalid-parameter",
            "Only one querystring parameter is allowed",
            at.node,
          )
        continue
      }
      const field = this.parameterField(at, value)
      const location = value.in as string
      if (location === "querystring") {
        out.querystring = { type: field.type, required: field.required, location: field.location }
        if (field.annotations) out.querystring.annotations = field.annotations
        const [mediaType] = isRecord(value.content) ? Object.keys(value.content) : []
        if (mediaType !== undefined) out.querystring.mediaType = mediaType
        if (mediaType !== undefined && classifyMediaType(mediaType) === "form") {
          // Form fields serialize like query parameters, by their Encoding Objects.
          const media = resolveObject(
            this.context,
            this.context.documents.child(at.node, "content", mediaType),
          )
          const encoding = media && formEncoding(this.context, media.node, false)
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
    if (ignoredQuery) {
      this.context.warn(
        "invalid-parameter",
        "A querystring parameter cannot be combined with query parameters; the query parameters are ignored",
        own,
      )
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
      if (media === undefined) return UNKNOWN
      // The 3.2 querystring uses body encodings, but raw media still travels as URL text.
      const type = typeOfContent(this.schemas, media.node, content[0], value.in !== "querystring")
      return type.kind === "blob" ? { kind: "string" } : type
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
  pathParams(
    declared: Field[],
    kind: "endpoint" | "webhook" | "callback",
    label: string,
    node: DocumentNode,
  ): Field[] {
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

  responseHeaders(node: DocumentNode): Field[] {
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
