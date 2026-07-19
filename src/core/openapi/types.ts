/**
 * Minimal OpenAPI 3.0/3.1 model consumed by openapi-shape.
 *
 * Before contract building, OpenAPI 3.0 `nullable` schemas become explicit
 * unions and supported component `$ref`s are resolved.
 *
 * Fields that may carry pre-resolution `$ref`s keep identifying fields optional so
 * pre-resolution `$ref` placeholders remain type-legal.
 */

export type { HttpMethod } from "../shared/http"
export { HTTP_METHODS } from "../shared/http"

/** Supported subset of an OpenAPI document after loader preparation. */
export interface OpenAPIDocument {
  openapi?: string
  info?: Info
  paths?: Record<string, PathItem>
  components?: Components
  webhooks?: Record<string, PathItem>
}

/** Supported fields from OpenAPI's top-level `info` object. */
export interface Info {
  title?: string
  version?: string
  description?: string
}

/** Reusable OpenAPI components supported by the preparation pipeline. */
export interface Components {
  schemas?: Record<string, OpenAPISchema>
  parameters?: Record<string, Parameter>
  requestBodies?: Record<string, RequestBody>
  responses?: Record<string, Response>
  pathItems?: Record<string, PathItem>
  callbacks?: Record<string, Callback>
}

/** OpenAPI path item object for endpoints, webhooks, and path item components. */
export interface PathItem {
  /** Component reference resolved before contract building. */
  $ref?: string
  /** Parameters shared by every operation on this path item. */
  parameters?: Parameter[]
  get?: Operation
  put?: Operation
  post?: Operation
  delete?: Operation
  options?: Operation
  head?: Operation
  patch?: Operation
  trace?: Operation
}

/** OpenAPI operation object consumed by contract operation building. */
export interface Operation {
  operationId?: string
  tags?: string[]
  summary?: string
  description?: string
  deprecated?: boolean
  /** Operation-level parameters, merged over path-level parameters. */
  parameters?: Parameter[]
  /** Optional request body for methods that accept payloads. */
  requestBody?: RequestBody
  /** Response map keyed by OpenAPI response status keys. */
  responses?: Record<string, Response>
  /** Out-of-band requests initiated in response to this operation. */
  callbacks?: Record<string, Callback>
}

/** OpenAPI callback object or unresolved callback component reference. */
export type Callback = { $ref: string } | Record<string, PathItem>

export function isCallbackReference(callback: Callback): callback is { $ref: string } {
  return "$ref" in callback && typeof callback.$ref === "string"
}

/** OpenAPI parameter object or unresolved parameter reference. */
export interface Parameter {
  /** Component reference resolved before contract building. */
  $ref?: string
  /** Parameter name as declared by OpenAPI. Optional to allow unresolved refs. */
  name?: string
  /** Parameter location. Cookies are parsed but not emitted into the contract. */
  in?: "path" | "query" | "header" | "cookie"
  required?: boolean
  /** Parameter schema used for query parameters; path/header parameters render as strings. */
  schema?: OpenAPISchema
  description?: string
  deprecated?: boolean
}

/** OpenAPI request body object or unresolved request body reference. */
export interface RequestBody {
  /** Component reference resolved before contract building. */
  $ref?: string
  required?: boolean
  /** Media type map used to select the request payload type. */
  content?: Record<string, MediaType>
  /** Request body description. Currently retained only in the prepared document. */
  description?: string
}

/** OpenAPI response object or unresolved response reference. */
export interface Response {
  /** Component reference resolved before contract building. */
  $ref?: string
  /** Media type map used to select the response type. */
  content?: Record<string, MediaType>
  /** Response description. Currently retained only in the prepared document. */
  description?: string
}

/** Media type entry. Only schemas are consumed by declaration rendering. */
export interface MediaType {
  schema?: OpenAPISchema
}

/** OpenAPI discriminator metadata used to inject string literal tags into branches. */
export interface Discriminator {
  propertyName: string
  /** Maps discriminator values to branch `$ref` targets. */
  mapping?: Record<string, string>
}

/**
 * Supported subset of an OpenAPI Schema Object.
 *
 * This type intentionally models only keywords used by normalization,
 * discriminator injection, contract building, and declaration rendering.
 */
export type OpenAPISchema = boolean | OpenAPISchemaObject

export interface OpenAPISchemaObject {
  /** Schema reference. Schema `$ref`s are preserved for declaration rendering. */
  $ref?: string
  /** JSON Schema type or OpenAPI 3.1 nullable-style type array. */
  type?: string | string[]
  /** OpenAPI/JSON Schema format, optionally mapped by declaration options. */
  format?: string
  /** Literal enum values rendered as TypeScript unions. */
  enum?: unknown[]
  /** JSON Schema const value rendered as a TypeScript literal when supported. */
  const?: unknown

  /** Exclusive alternatives; rendered as a TypeScript union. */
  oneOf?: OpenAPISchema[]
  /** Inclusive alternatives; rendered as a TypeScript union. */
  anyOf?: OpenAPISchema[]
  /** Composition rendered as a TypeScript intersection. */
  allOf?: OpenAPISchema[]

  properties?: Record<string, OpenAPISchema>
  /** Pattern property schemas folded into an index signature value type. */
  patternProperties?: Record<string, OpenAPISchema>
  required?: string[]
  /** Additional property policy or schema for object index signatures. */
  additionalProperties?: boolean | OpenAPISchema

  /** Array item schema, or `true` for unconstrained tuple rest items. */
  items?: OpenAPISchema | boolean
  prefixItems?: OpenAPISchema[]

  discriminator?: Discriminator

  /** OpenAPI 3.0 marker normalized to an explicit union with `null`. */
  nullable?: boolean

  description?: string
  summary?: string
  deprecated?: boolean
}

export function isSchemaObject(schema: OpenAPISchema | undefined): schema is OpenAPISchemaObject {
  return typeof schema === "object" && schema !== null
}
