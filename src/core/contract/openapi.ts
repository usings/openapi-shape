/**
 * Minimal OpenAPI 3.0/3.1 model consumed by openapi-shape.
 *
 * Loader stages prepare this shape before Contract building:
 * - 3.0 primitive `nullable` schemas become 3.1 type arrays.
 * - Supported component `$ref`s are resolved before rendering.
 *
 * Fields that may carry $ref pre-resolution declare $ref as optional.
 * Identifying fields such as Parameter.name and Parameter.in stay optional so
 * pre-resolution `$ref` placeholders remain type-legal.
 */

/** HTTP methods supported by OpenAPI path items and emitted contract operations. */
export type HttpMethod = "get" | "post" | "put" | "delete" | "patch" | "head" | "options" | "trace"

export const HTTP_METHODS: HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]

/** Supported subset of an OpenAPI document after loader preparation. */
export interface OpenAPIDocument {
  /** OpenAPI version string, for example `3.0.3` or `3.1.0`. */
  openapi?: string
  /** Document metadata surfaced into the generated declarations header. */
  info?: Info
  /** HTTP endpoint path map. */
  paths?: Record<string, PathItem>
  /** Reusable component definitions consumed by the loader and contract builder. */
  components?: Components
  /** OpenAPI 3.1 webhook map. */
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
  /** Named schemas emitted under the generated `Schemas` namespace. */
  schemas?: Record<string, OpenAPISchema>
  /** Parameter components eligible for `$ref` resolution. */
  parameters?: Record<string, Parameter>
  /** Request body components eligible for `$ref` resolution. */
  requestBodies?: Record<string, RequestBody>
  /** Response components eligible for `$ref` resolution. */
  responses?: Record<string, Response>
  /** Path item components eligible for `$ref` resolution. */
  pathItems?: Record<string, PathItem>
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
  /** Optional OpenAPI operation identifier preserved on the contract. */
  operationId?: string
  /** Optional grouping tags preserved on the contract. */
  tags?: string[]
  /** Short text copied into operation documentation. */
  summary?: string
  /** Long text copied into operation documentation. */
  description?: string
  /** Deprecation marker copied into operation documentation. */
  deprecated?: boolean
  /** Operation-level parameters, merged over path-level parameters. */
  parameters?: Parameter[]
  /** Optional request body for methods that accept payloads. */
  requestBody?: RequestBody
  /** Response map keyed by OpenAPI response status keys. */
  responses?: Record<string, Response>
}

/** OpenAPI parameter object or unresolved parameter reference. */
export interface Parameter {
  /** Component reference resolved before contract building. */
  $ref?: string
  /** Parameter name as declared by OpenAPI. Optional to allow unresolved refs. */
  name?: string
  /** Parameter location. Cookies are parsed but not emitted into the contract. */
  in?: "path" | "query" | "header" | "cookie"
  /** Whether the parameter is required. Path parameters are forced required later. */
  required?: boolean
  /** Parameter schema used for query parameters; path/header parameters render as strings. */
  schema?: OpenAPISchema
  /** Parameter description copied into field documentation. */
  description?: string
  /** Parameter deprecation marker copied into field documentation. */
  deprecated?: boolean
}

/** OpenAPI request body object or unresolved request body reference. */
export interface RequestBody {
  /** Component reference resolved before contract building. */
  $ref?: string
  /** Whether callers must send the request body. */
  required?: boolean
  /** Media type map used to select the request payload shape. */
  content?: Record<string, MediaType>
  /** Request body description. Currently retained only in the prepared document. */
  description?: string
}

/** OpenAPI response object or unresolved response reference. */
export interface Response {
  /** Component reference resolved before contract building. */
  $ref?: string
  /** Media type map used to select the response shape. */
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
  /** Property name that identifies a `oneOf` or `anyOf` branch. */
  propertyName: string
  /** Optional discriminator value to `$ref` target mapping. */
  mapping?: Record<string, string>
}

/**
 * Supported subset of an OpenAPI Schema Object.
 *
 * This type intentionally models only keywords used by normalization,
 * discriminator injection, contract building, and declaration rendering.
 */
export interface OpenAPISchema {
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

  /** Union-like alternatives rendered as a TypeScript union. */
  oneOf?: OpenAPISchema[]
  /** Union-like alternatives rendered as a TypeScript union. */
  anyOf?: OpenAPISchema[]
  /** Composition rendered as a TypeScript intersection. */
  allOf?: OpenAPISchema[]

  /** Object property schemas. */
  properties?: Record<string, OpenAPISchema>
  /** Pattern property schemas folded into an index signature value type. */
  patternProperties?: Record<string, OpenAPISchema>
  /** Required object property names. */
  required?: string[]
  /** Additional property policy or schema for object index signatures. */
  additionalProperties?: boolean | OpenAPISchema

  /** Array item schema, or `true` for unconstrained tuple rest items. */
  items?: OpenAPISchema | boolean
  /** Tuple prefix item schemas. */
  prefixItems?: OpenAPISchema[]

  /** Discriminator metadata used before contract building. */
  discriminator?: Discriminator

  /** OpenAPI 3.0 nullable marker; normalized to 3.1 type arrays. */
  nullable?: boolean

  /** Schema description copied into generated JSDoc when supported. */
  description?: string
  /** Schema summary copied into generated JSDoc when supported. */
  summary?: string
  /** Schema deprecation marker copied into generated JSDoc when supported. */
  deprecated?: boolean
}
