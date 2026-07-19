import type { HttpMethod } from "../shared/http"

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
  type: ContractType
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
  | { kind: "json"; required: boolean; type: ContractType }
  /** Non-JSON request body kept as its selected schema type. */
  | { kind: "passthrough"; required: boolean; type: ContractType }

/**
 * One OpenAPI response entry after media-type selection.
 *
 * Response status keys are preserved exactly as declared by OpenAPI.
 */
export interface ContractOutcome {
  /** OpenAPI response key, for example `"200"`, `"4XX"`, or `"default"`. */
  status: string
  /** Selected response type, or `void` when no usable content schema exists. */
  type: ContractType
  /** Media type that produced `type`, when a content entry was selected. */
  contentType?: string
  /** Source location of this response entry. */
  source?: SourceRef
}

/**
 * A named schema from `components.schemas`.
 *
 * Object schemas with properties become `interface` entries and carry `fields`.
 * Everything else becomes an `alias` entry and carries a single `type`.
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
        /** Index-signature value type before widening, when the object permits additional keys. */
        index?: ContractType
      }
    | {
        kind: "alias"
        type: ContractType
      }
  )

/** Scalar type names used by contract types, following TypeScript naming. */
export type ScalarName = "string" | "number" | "boolean" | "null"

/**
 * Type tree produced by contract building, decoupled from OpenAPI schemas.
 *
 * All OpenAPI schema interpretation happens before this tree is built:
 * `$ref`s are resolved to `reference` names, compositions become
 * `union`/`intersection`, and object keywords become `object`/`record`.
 * Renderers only decide target-language syntax, such as mapping `binary`
 * to `Blob` or applying user `format` mappings to scalars.
 *
 * The tree is not language-neutral: reference names are already sanitized
 * TypeScript identifiers, `integer` is collapsed to `number`, and kind
 * names follow TypeScript conventions.
 */
export type ContractType =
  /** Unconstrained or unsupported schema. Renders as `unknown`. */
  | { kind: "unknown" }
  /** Unsatisfiable schema, such as `false` or an empty enum. */
  | { kind: "never" }
  /** Absent payload, such as a response without content. */
  | { kind: "void" }
  /** Primitive with its declared `format` kept for renderer mappings. */
  | { kind: "scalar"; name: ScalarName; format?: string }
  /** Binary payload. `format` is present when derived from a schema keyword. */
  | { kind: "binary"; format?: "binary" | "byte" }
  | { kind: "literal"; value: string | number | boolean | null }
  /** Resolved and sanitized name of a `components.schemas` entry. */
  | { kind: "reference"; name: string }
  | { kind: "array"; items: ContractType }
  | { kind: "tuple"; items: ContractType[]; rest?: ContractType }
  /** Object with declared fields. `index` is the index value type before widening. */
  | { kind: "object"; fields: ContractField[]; index?: ContractType }
  /** Object without declared fields, keyed by arbitrary strings. */
  | { kind: "record"; values: ContractType }
  | { kind: "union"; members: ContractType[] }
  | { kind: "intersection"; members: ContractType[] }

/** Documentation that can be rendered as a TypeScript JSDoc block. */
export interface DocBlock {
  summary?: string
  description?: string
  deprecated?: boolean
}
