import { mergeAnnotations, objectAnnotations, schemaAnnotations } from "./annotations"
import type { BuildContext } from "./build-context"
import { selectParameterValue } from "./content-sources"
import type { DocumentNode } from "./documents"
import { encodingOf } from "./encoding"
import { formEncoding } from "./form-encoding"
import { typeOfContent } from "./media-schema"
import { classifyMediaType } from "./media-types"
import type { Annotations, Field, OperationModel, TypeNode } from "./model"
import { UNKNOWN } from "./model"
import { isRecord } from "./object"
import type { Resolved } from "./object-references"
import { reportSourceIssues, resolveObject } from "./object-references"
import { selectParameterSources } from "./operation-sources"
import type { SchemaBuilder } from "./schemas"

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
    const { parameters, selected, issues } = selectParameterSources(
      this.context.documents,
      shared,
      own,
    )
    reportSourceIssues(this.context, issues)

    const out = {
      path: [] as Field[],
      query: [] as Field[],
      header: [] as Field[],
      cookie: [] as Field[],
      querystring: undefined as OperationModel["querystring"],
    }
    let ignoredQuery = false
    for (const parameter of parameters) {
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

  /** TypeNode of a Parameter or Header Object: its `schema`, or its single `content` entry. */
  private valueType(node: DocumentNode, value: Record<string, unknown>, what: string): TypeNode {
    const hasSchema = "schema" in value
    const content = isRecord(value.content) ? Object.keys(value.content) : []
    if (hasSchema && content.length > 0) {
      this.context.warn(
        "invalid-parameter",
        `A ${what} cannot have both "schema" and "content"; "schema" is used`,
        node,
      )
    }
    const source = selectParameterValue(this.context.documents, node)
    if (source.kind === "schema") return this.schemas.type(source.node)
    if (source.kind === "content") {
      if (content.length > 1) {
        this.context.warn(
          "invalid-parameter",
          `A ${what}'s "content" must have exactly one entry; the first is used`,
          node,
          "content",
        )
      }
      const media = resolveObject(this.context, source.node)
      if (media === undefined) return UNKNOWN
      // The 3.2 querystring uses body encodings, but raw media still travels as URL text.
      const type = typeOfContent(
        this.schemas,
        media.node,
        source.mediaType,
        value.in !== "querystring",
      )
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

  /** Path parameters must match the path template one-to-one (operations only). */
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
      // "If a response header is defined with the name "Content-TypeNode", it SHALL be ignored."
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
