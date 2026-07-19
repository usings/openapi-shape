import type { HttpMethod, OpenAPISchema } from "./openapi"

/**
 * Normalized contract intermediate representation.
 *
 * Built after version normalization, reference resolution, and discriminator
 * expansion so renderers do not need to interpret the raw document again.
 */
export interface Contract {
  info: DocumentInfo
  schemas: ContractSchema[]
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

interface OperationBase {
  /**
   * Stable declaration key for this operation.
   *
   * The default shape is `${METHOD} ${pathOrWebhookName}`, for example
   * `"GET /pets"` or `"POST pet.created"`.
   */
  key: string
  method: HttpMethod
  operationId?: string
  tags: string[]
  summary?: string
  description?: string
  deprecated: boolean
  /** Query-string parameters after path-level and operation-level merge. */
  query: ContractField[]
  /** Header parameters after path-level and operation-level merge. */
  headers: ContractField[]
  /** Request payload selected from the operation request body. */
  body: ContractPayload
  /** Declared responses, preserving OpenAPI response key order. */
  responses: ContractOutcome[]
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

/** An operation declared inside an OpenAPI callback expression. */
export interface CallbackOperation extends OperationBase {
  kind: "callback"
  /** Key of the endpoint or webhook operation that declares the callback. */
  parentKey: string
  /** Name of the callback on the parent operation. */
  callbackName: string
  /** Runtime expression or URL used as the callback path-item key. */
  expression: string
}

/** Endpoint, webhook, or callback operation. Narrow with the `kind` discriminator. */
export type ContractOperation = EndpointOperation | WebhookOperation | CallbackOperation

/**
 * Named field used for parameters and object properties.
 *
 * For operation parameters, `required` reflects OpenAPI parameter requiredness
 * except path parameters, which are always required. For schema properties,
 * `required` is derived from the parent object's `required` array.
 */
export interface ContractField {
  name: string
  required: boolean
  shape: ContractShape
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
interface ContractSchemaBase {
  /** Safe TypeScript identifier used in generated declarations. */
  name: string
  /** Original OpenAPI schema name. */
  originalName: string
  /** Documentation attached to the source schema. */
  docs?: DocBlock
  /** Source location of the schema in `components.schemas`. */
  source?: SourceRef
}

export type ContractSchema = ContractSchemaBase &
  (
    | {
        kind: "interface"
        fields: ContractField[]
        /** Index-signature value type, when the object permits additional keys. */
        index?: ContractShape
      }
    | {
        kind: "alias"
        shape: ContractShape
      }
  )

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
  summary?: string
  description?: string
  deprecated?: boolean
}
