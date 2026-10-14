/**
 * The contract: every operation and named type of an OpenAPI Description,
 * with all OpenAPI and JSON Schema semantics already applied. Renderers only
 * choose syntax.
 */
export interface Contract {
  info: Info
  endpoints: Operation[]
  webhooks: Operation[]
  callbacks: Operation[]
  /** Named types, in output order. */
  declarations: Declaration[]
  /** What a client needs at run time and cannot learn from types. */
  runtime: Runtime
}

/** Document-level runtime details for the client. */
export interface Runtime {
  /** Server URLs, variables filled with their defaults. */
  servers: string[]
  /** Security schemes by name. */
  security: Record<string, SecurityScheme>
  /** Default security requirements. */
  requires?: SecurityRequirement[]
}

/** Security scheme names, each with its required scopes; any one requirement of a list suffices. */
export type SecurityRequirement = Record<string, string[]>

export type SecurityScheme =
  | { type: "apiKey"; in: "header" | "query" | "cookie"; name: string }
  /** `scheme` is lowercase: `bearer`, `basic`, … */
  | { type: "http"; scheme: string }
  | { type: "oauth2" | "openIdConnect" | "mutualTLS" }

/** How a value is serialized, where it differs from OpenAPI's default for its location. */
export interface Encoding {
  style?: string
  explode?: boolean
  allowReserved?: boolean
  /** A parameter's `content` media type, or an Encoding Object's `contentType`. */
  contentType?: string
}

export interface Info {
  /** The entry document's `openapi` field. */
  openapi: string
  title?: string
  version?: string
  description?: string
}

/**
 * Which side of an exchange a type describes. OpenAPI 3.0 `readOnly` and
 * `writeOnly` make `required` apply to one side only (OpenAPI 3.0 Schema Object, `readOnly`).
 */
export type View = "request" | "response"

export interface Operation {
  /** `"GET /pets"`, `"POST pet.created"`, or `"<parent> > <callback> > POST <expression>"`. */
  key: string
  docs?: Docs
  params: Field[]
  query: Field[]
  /** The `in: querystring` parameter (3.2), which describes the whole query string. */
  querystring?: {
    type: Type
    required: boolean
    docs?: Docs
    /** The media type, unless form-urlencoded. */
    mediaType?: string
    /** Form content: its Encoding Objects, by field. */
    encoding?: Record<string, Encoding>
  }
  headers: Field[]
  cookies: Field[]
  body?: Body
  responses: Response[]
  /** The operation's own security requirements (overriding the document's); endpoints only. */
  requires?: SecurityRequirement[]
  /** The operation's (or else its Path Item's) servers; endpoints only. */
  servers?: string[]
}

export interface Body {
  required: boolean
  docs?: Docs
  /** One entry per declared media type, in declaration order. */
  content: Media[]
}

export interface Media {
  mediaType: string
  type: Type
  /** Request form and multipart bodies: Encoding Objects by property, where they differ from the default. */
  encoding?: Record<string, Encoding>
}

export interface Response {
  /** Status key as declared: `"200"`, `"4XX"`, or `"default"`. */
  status: string
  docs?: Docs
  /** Union of all media types' types; `undefined` when the response has no content. */
  type: Type
  headers: Field[]
}

export interface Field {
  name: string
  type: Type
  required: boolean
  /** Set when `required` holds on one side only (readOnly/writeOnly). */
  requiredOnly?: View
  docs?: Docs
  /** Parameters: serialization, where it differs from the location's default. */
  encoding?: Encoding
}

export interface Declaration {
  /** Identifier inside the `Schemas` namespace. */
  name: string
  /** Name of the request-side variant, when it differs (see {@link View}). */
  inputName?: string
  type: Type
  docs?: Docs
}

export interface Docs {
  title?: string
  summary?: string
  description?: string
  deprecated?: boolean
  /** JSDoc block tags such as `["minimum", "1"]`, in output order. */
  tags?: Array<[name: string, value: string]>
}

export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal }

export type Type =
  | { kind: "unknown" }
  | { kind: "never" }
  /** Absent content, such as a response without a body. */
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "boolean" }
  /** `format` is kept so renderers can apply user format mappings. */
  | { kind: "string"; format?: string }
  | { kind: "number"; format?: string }
  /** Raw octets. */
  | { kind: "binary" }
  | { kind: "literal"; value: Literal }
  | { kind: "ref"; target: Declaration }
  /**
   * `inferred` marks shapes implied only by type-specific keywords (no `type`):
   * JSON Schema applies those keywords to arrays/objects alone, so an inferred
   * shape yields to a definite non-matching type in an intersection.
   */
  | { kind: "array"; items: Type; inferred?: true }
  /** Leading elements; those at index `>= required` are optional. `rest` absent means closed. */
  | { kind: "tuple"; items: Type[]; required: number; rest?: Type; inferred?: true }
  /**
   * `additional` types properties no field or pattern names (additionalProperties);
   * `patterns` types properties whose names match a regular expression.
   */
  | {
      kind: "object"
      fields: Field[]
      additional?: Type
      patterns?: Array<{ pattern: string; type: Type }>
      inferred?: true
    }
  | { kind: "union"; members: Type[] }
  | { kind: "intersection"; members: Type[] }
  /**
   * A discriminator's values for `property`, applied to `type` once every
   * declaration is built (the schema's own literals win). Never rendered.
   */
  | {
      kind: "narrow"
      type: Type
      property: string
      values: string[]
      explicit: boolean
      location: string
    }

/** The types directly inside `type`, not looking through references. */
export function childTypes(type: Type): Type[] {
  switch (type.kind) {
    case "object":
      return [
        ...type.fields.map((f) => f.type),
        ...(type.additional ? [type.additional] : []),
        ...(type.patterns ?? []).map((p) => p.type),
      ]
    case "array":
      return [type.items]
    case "tuple":
      return type.rest ? [...type.items, type.rest] : type.items
    case "union":
    case "intersection":
      return type.members
    case "narrow":
      return [type.type]
    default:
      return []
  }
}

export const UNKNOWN: Type = { kind: "unknown" }
export const NEVER: Type = { kind: "never" }
export const UNDEFINED: Type = { kind: "undefined" }
export const NULL: Type = { kind: "null" }
