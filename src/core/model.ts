import type { Encoding as SharedEncoding } from "../shared/encoding"

/**
 * The resolved schema and operation graph. Compilation projects schemas for each exchange and
 * records endpoint serialization settings before rendering.
 */
export interface ApiModel {
  info: Info
  operations: OperationModel[]
  webhooks: OperationModel[]
  callbacks: OperationModel[]
  /** Named types, in output order. */
  declarations: TypeDeclaration[]
}

export type Encoding = { -readonly [K in keyof SharedEncoding]: SharedEncoding[K] }

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

export interface OperationModel {
  /** `"GET /pets"`, `"POST pet.created"`, or `"<parent> > <callback> > POST <expression>"`. */
  key: string
  annotations?: Annotations
  params: Field[]
  query: Field[]
  /** The `in: querystring` parameter (3.2), which describes the whole query string. */
  querystring?: {
    /** Source location for generation diagnostics; never rendered. */
    location?: string
    type: TypeNode
    required: boolean
    annotations?: Annotations
    /** The media type, including form-urlencoded. */
    mediaType?: string
    /** Form content: its Encoding Objects, by field. */
    encoding?: Record<string, Encoding>
  }
  headers: Field[]
  cookies: Field[]
  body?: Body
  responses: ResponseModel[]
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
  type: TypeNode
  /** Request form bodies: field encodings, including explicit multipart styles. */
  encoding?: Record<string, Encoding>
}

export interface ResponseModel {
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
  type: TypeNode
  required: boolean
  /** Set when `required` holds on one side only (readOnly/writeOnly). */
  requiredOnly?: Side
  /** The property's annotation, including when no member currently requires it. */
  direction?: Side | "both"
  annotations?: Annotations
  /** Parameters: serialization, where it differs from the location's default. */
  encoding?: Encoding
}

export interface TypeDeclaration {
  /** Source location for diagnostics during output projection; never rendered. */
  location?: string
  /** The reference graph has finished defining this declaration. */
  complete?: true
  /** Identifier inside the `Schemas` namespace. */
  name: string
  /** Name of the request-side variant, when it differs (see {@link Side}). */
  inputName?: string
  type: TypeNode
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

export type TypeNode =
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
  /** A string schema annotated as binary, projected by transport. */
  | { kind: "binary" }
  /** Raw media content, independent of schema string annotations. */
  | { kind: "blob" }
  | { kind: "literal"; value: Literal }
  | { kind: "ref"; target: TypeDeclaration }
  /**
   * `inferred` marks shapes implied only by type-specific keywords (no `type`): JSON Schema applies
   * those keywords to arrays/objects alone, so an inferred shape yields to a definite non-matching
   * type in an intersection.
   */
  | { kind: "array"; items: TypeNode; inferred?: true }
  /** Leading elements; those at index `>= required` are optional. `rest` absent means closed. */
  | { kind: "tuple"; items: TypeNode[]; required: number; rest?: TypeNode; inferred?: true }
  /**
   * `additional` types properties no field or pattern names (additionalProperties); `patterns`
   * types properties whose names match a regular expression.
   */
  | {
      kind: "object"
      fields: Field[]
      additional?: TypeNode
      patterns?: Array<{ pattern: string; type: TypeNode }>
      inferred?: true
    }
  | { kind: "union"; members: TypeNode[] }
  | { kind: "intersection"; members: TypeNode[]; [TYPE_LOCATION]?: string }
  /**
   * A discriminator's values for `property`, applied to `type` once every declaration is built (the
   * schema's own literals win). Never rendered.
   */
  | {
      kind: "narrow"
      type: TypeNode
      property: string
      values: string[]
      explicit: boolean
      location: string
    }

/** The types directly inside `type`, not looking through references. */
export function childTypes(type: TypeNode): TypeNode[] {
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

export const UNKNOWN: TypeNode = { kind: "unknown" }
export const NEVER: TypeNode = { kind: "never" }
export const UNDEFINED: TypeNode = { kind: "undefined" }
export const NULL: TypeNode = { kind: "null" }

export type OperationGroups = Pick<ApiModel, "operations" | "webhooks" | "callbacks">
