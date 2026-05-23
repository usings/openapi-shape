import type { HttpMethod, OpenAPISchema } from "./openapi"

/**
 * Normalized contract intermediate representation.
 *
 * This is the stable handoff from OpenAPI ingestion to declaration rendering. It is
 * built after reference resolution, OpenAPI 3.0 to 3.1 normalization, and
 * discriminator expansion, so downstream renderers can avoid re-reading the raw
 * OpenAPI document shape.
 */
export interface Contract {
  /** Sanitized document metadata from the OpenAPI `info` object. */
  info: DocumentInfo
  /** Named schemas collected from `components.schemas`, in source order. */
  schemas: ContractSchema[]
  /** Endpoint and webhook operations collected from `paths` and `webhooks`. */
  operations: ContractOperation[]
}

/**
 * API metadata copied from OpenAPI's `info` object.
 *
 * Empty and whitespace-only values are omitted during contract building.
 */
export interface DocumentInfo {
  title?: string
  version?: string
  description?: string
}

/**
 * JSON Pointer to the corresponding location in the prepared OpenAPI document.
 *
 * Source references are kept on contract nodes that may need precise diagnostics
 * or source-aware rendering later.
 */
export interface SourceRef {
  location: string
}

/** Common operation metadata shared by endpoints and webhooks. */
interface OperationBase {
  /**
   * Stable declaration key for this operation.
   *
   * The default shape is `${METHOD} ${pathOrWebhookName}`, for example
   * `"GET /pets"` or `"POST pet.created"`.
   */
  key: string
  /** Lowercase HTTP method as declared by the OpenAPI path item. */
  method: HttpMethod
  /** Optional OpenAPI `operationId`, preserved for adapters that prefer it. */
  operationId?: string
  /** OpenAPI operation tags, normalized to an empty array when absent. */
  tags: string[]
  /** Short operation summary copied from OpenAPI. */
  summary?: string
  /** Long operation description copied from OpenAPI. */
  description?: string
  /** True only when OpenAPI marks the operation as deprecated. */
  deprecated: boolean
  /** Query-string parameters after path-level and operation-level merge. */
  query: ContractField[]
  /** Header parameters after path-level and operation-level merge. */
  headers: ContractField[]
  /** Request payload selected from the operation request body. */
  body: ContractPayload
  /** Declared responses, preserving OpenAPI response key order. */
  responses: ContractOutcome[]
  /** Source location of the operation object. */
  source?: SourceRef
}

/** Operation reachable through an HTTP path declared under OpenAPI `paths`. */
export interface EndpointOperation extends OperationBase {
  kind: "endpoint"
  /** OpenAPI path template, for example `/pets/{petId}`. */
  path: string
  /** Path parameters. They are rendered as strings regardless of schema type. */
  params: ContractField[]
}

/**
 * Operation declared under OpenAPI `webhooks`.
 *
 * Webhooks are addressed by their webhook name rather than by a URL path, and
 * they do not carry path parameters.
 */
export interface WebhookOperation extends OperationBase {
  kind: "webhook"
  /** OpenAPI webhook map key, for example `pet.created`. */
  name: string
}

/** Endpoint or webhook operation. Narrow with the `kind` discriminator. */
export type ContractOperation = EndpointOperation | WebhookOperation

/**
 * Named field used for parameters and object properties.
 *
 * For operation parameters, `required` reflects OpenAPI parameter requiredness
 * except path parameters, which are always required. For schema properties,
 * `required` is derived from the parent object's `required` array.
 */
export interface ContractField {
  /** Original parameter or property name before TypeScript key escaping. */
  name: string
  /** Whether callers must provide this field. */
  required: boolean
  /** Deferred type information for declaration rendering. */
  shape: ContractShape
  /** Documentation attached to the parameter or property. */
  docs?: DocBlock
}

/**
 * Operation request payload selected from `requestBody.content`.
 *
 * `json` is chosen for the first JSON-family media type with a schema.
 * `passthrough` is chosen for the first non-JSON media type with a schema.
 * `none` means no usable request body schema was declared.
 */
export type ContractPayload =
  /** No declared request body, or no request body schema that can be rendered. */
  | { kind: "none" }
  /** JSON-family request body, such as `application/json` or `application/problem+json`. */
  | { kind: "json"; required: boolean; shape: ContractShape }
  /** Non-JSON request body kept as its selected schema shape. */
  | { kind: "passthrough"; required: boolean; shape: ContractShape }

/**
 * One OpenAPI response entry after media-type selection.
 *
 * Response status keys are preserved exactly as declared by OpenAPI.
 */
export interface ContractOutcome {
  /** OpenAPI response key, for example `"200"`, `"4XX"`, or `"default"`. */
  status: string
  /** Selected response type, or `void` when no usable content schema exists. */
  shape: ContractShape
  /** Media type that produced `shape`, when a content entry was selected. */
  contentType?: string
  /** Source location of this response entry. */
  source?: SourceRef
}

/**
 * A named schema from `components.schemas`.
 *
 * Object schemas with properties become `interface` entries and carry `fields`.
 * Everything else becomes an `alias` entry and carries a single `shape`.
 */
export interface ContractSchema {
  /** Safe TypeScript identifier used in generated declarations. */
  name: string
  /** Original OpenAPI schema name. */
  originalName: string
  /** Rendering strategy for this schema. */
  kind: "interface" | "alias"
  /** Interface fields when `kind` is `"interface"`; otherwise `null`. */
  fields: ContractField[] | null
  /** Alias target when `kind` is `"alias"`; otherwise `null`. */
  shape: ContractShape | null
  /**
   * Index-signature value type for interface schemas with `patternProperties` or
   * schema-valued `additionalProperties`.
   */
  index?: ContractShape | null
  /** Documentation attached to the source schema. */
  docs?: DocBlock
  /** Source location of the schema in `components.schemas`. */
  source?: SourceRef
}

/**
 * Deferred type slot used by the declaration renderer.
 *
 * `schema` keeps the normalized OpenAPI schema available for later conversion to
 * TypeScript. `primitive` represents a contract-level decision that should render
 * verbatim, such as path and header parameters being strings.
 */
export type ContractShape =
  /** Type derived from an OpenAPI schema. `undefined` renders as `unknown`. */
  | { kind: "schema"; schema: OpenAPISchema | undefined }
  /** Type chosen directly by the contract builder. */
  | { kind: "primitive"; name: PrimitiveName }

/** TypeScript primitive or built-in names emitted verbatim by renderers. */
export type PrimitiveName =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "void"
  | "unknown"
  | "never"
  | "Blob"

/** Documentation that can be rendered as a TypeScript JSDoc block. */
export interface DocBlock {
  /** Short human-readable summary. */
  summary?: string
  /** Longer markdown-capable description. */
  description?: string
  /** Whether to emit an `@deprecated` tag. */
  deprecated?: boolean
}
