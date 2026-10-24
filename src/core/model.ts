import type { EndpointContract } from "../shared/contract"

/**
 * The resolved schema and operation graph. Compilation projects schemas for each exchange and
 * records endpoint serialization settings before rendering.
 */
export interface Model {
  info: Info
  endpoints: Operation[]
  webhooks: Operation[]
  callbacks: Operation[]
  /** Named types, in output order. */
  declarations: Declaration[]
}

/** Projected model ready for TypeScript output. */
export interface OutputModel extends Omit<Model, "endpoints"> {
  endpoints: OutputOperation[]
}

export interface OutputOperation extends Operation {
  contract: EndpointContract
}

/** How a value is serialized, where it differs from OpenAPI's default for its location. */
export interface Encoding {
  /** Apply contentType separately to array items in a named form field. */
  repeat?: boolean
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
  /** The entry document's server URLs, as written. */
  servers: string[]
}

/**
 * Which side of an exchange a type describes. OpenAPI 3.0 `readOnly` and `writeOnly` make
 * `required` apply to one side only (OpenAPI 3.0 Schema Object, `readOnly`).
 */
export type Side = "request" | "response"

export interface Operation {
  /** `"GET /pets"`, `"POST pet.created"`, or `"<parent> > <callback> > POST <expression>"`. */
  key: string
  annotations?: Annotations
  params: Field[]
  query: Field[]
  /** The `in: querystring` parameter (3.2), which describes the whole query string. */
  querystring?: {
    /** Source location for generation diagnostics; never rendered. */
    location?: string
    type: Type
    required: boolean
    annotations?: Annotations
    /** The media type, unless form-urlencoded. */
    mediaType?: string
    /** Form content: its Encoding Objects, by field. */
    encoding?: Record<string, Encoding>
  }
  headers: Field[]
  cookies: Field[]
  body?: Body
  responses: Response[]
}

export interface Body {
  required: boolean
  annotations?: Annotations
  /** One entry per declared media type, in declaration order. */
  content: Media[]
}

export interface Media {
  /** Source location for generation diagnostics; never rendered. */
  location?: string
  mediaType: string
  type: Type
  /** Request form bodies: field encodings, including explicit multipart styles. */
  encoding?: Record<string, Encoding>
}

export interface Response {
  /** Status key as declared: `"200"`, `"4XX"`, or `"default"`. */
  status: string
  annotations?: Annotations
  /** One entry per declared media type, in declaration order; empty without content. */
  content: Media[]
  headers: Field[]
}

export interface Field {
  /** Source location for generation diagnostics; never rendered. */
  location?: string
  name: string
  type: Type
  required: boolean
  /** Set when `required` holds on one side only (readOnly/writeOnly). */
  requiredOnly?: Side
  /** The property's annotation, including when no member currently requires it. */
  direction?: Side | "both"
  annotations?: Annotations
  /** Parameters: serialization, where it differs from the location's default. */
  encoding?: Encoding
}

export interface Declaration {
  /** Source location for diagnostics during output projection; never rendered. */
  location?: string
  /** The reference graph has finished defining this declaration. */
  complete?: true
  /** Identifier inside the `Schemas` namespace. */
  name: string
  /** Name of the request-side variant, when it differs (see {@link Side}). */
  inputName?: string
  type: Type
  annotations?: Annotations
}

export interface Annotations {
  title?: string
  summary?: string
  description?: string
  deprecated?: boolean
  /** JSDoc block tags such as `["minimum", "1"]`, in output order. */
  tags?: Array<[name: string, value: string]>
}

export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal }

/** Diagnostic provenance is excluded from structural identity and emitted output. */
export const TYPE_LOCATION: unique symbol = Symbol("schema location")

export type Type =
  /** Widening keeps its provenance so later implied shapes cannot narrow it again. */
  | {
      kind: "unknown"
      widened?: true
      /** Object-level annotations survive even when their value constraints are widened away. */
      directions?: Array<{ name: string; direction: Side | "both" }>
    }
  | { kind: "never" }
  /** Absent, such as an optional property's value in an index signature. */
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "string" }
  | { kind: "number" }
  /** Raw octets. */
  | { kind: "binary" }
  | { kind: "literal"; value: Literal }
  | { kind: "ref"; target: Declaration }
  /**
   * `inferred` marks shapes implied only by type-specific keywords (no `type`): JSON Schema applies
   * those keywords to arrays/objects alone, so an inferred shape yields to a definite non-matching
   * type in an intersection.
   */
  | { kind: "array"; items: Type; inferred?: true }
  /** Leading elements; those at index `>= required` are optional. `rest` absent means closed. */
  | { kind: "tuple"; items: Type[]; required: number; rest?: Type; inferred?: true }
  /**
   * `additional` types properties no field or pattern names (additionalProperties); `patterns`
   * types properties whose names match a regular expression.
   */
  | {
      kind: "object"
      fields: Field[]
      additional?: Type
      patterns?: Array<{ pattern: string; type: Type }>
      inferred?: true
    }
  | { kind: "union"; members: Type[] }
  | { kind: "intersection"; members: Type[]; [TYPE_LOCATION]?: string }
  /**
   * A discriminator's values for `property`, applied to `type` once every declaration is built (the
   * schema's own literals win). Never rendered.
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
