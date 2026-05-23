import type { HttpMethod, OpenAPISchema } from "./openapi";

export interface Contract {
  info: DocumentInfo;
  schemas: ContractSchema[];
  operations: ContractOperation[];
}

export interface DocumentInfo {
  title?: string;
  version?: string;
  description?: string;
}

export interface SourceRef {
  location: string;
}

interface OperationBase {
  /** Stable operation key used when declaration adapters do not choose another key strategy. */
  key: string;
  method: HttpMethod;

  operationId?: string;
  tags: string[];
  summary?: string;
  description?: string;
  deprecated: boolean;

  query: ContractFields;
  headers: ContractFields;
  body: ContractPayload;
  responses: ContractOutcomes;
  source?: SourceRef;
}

export interface EndpointOperation extends OperationBase {
  kind: "endpoint";
  path: string;
  params: ContractFields;
}

export interface WebhookOperation extends OperationBase {
  kind: "webhook";
  name: string;
}

export type ContractOperation = EndpointOperation | WebhookOperation;

export interface ContractFields {
  fields: ContractField[];
}

export interface ContractField {
  name: string;
  required: boolean;
  shape: ContractShape;
  docs?: DocBlock;
}

export type ContractPayload =
  | { kind: "none" }
  | { kind: "json"; required: boolean; shape: ContractShape }
  | { kind: "passthrough"; required: boolean; shape: ContractShape };

export interface ContractOutcomes {
  /** Missing success payload; renderers usually emit `unknown`. */
  success: ContractShape | null;
  successStatus?: string;
  successContentType?: string;
  /** Collected for all builds; renderers may choose whether to emit it. */
  errors: ErrorResponse[];
}

export interface ErrorResponse {
  /** Explicit 4xx/5xx status or OpenAPI range such as "4XX"; `default` is excluded. */
  status: string;
  shape: ContractShape;
  contentType?: string;
  source?: SourceRef;
}

export interface ContractSchema {
  /** Sanitized TS identifier. */
  name: string;
  /** Original OpenAPI schema name. */
  originalName: string;
  kind: "interface" | "alias";
  fields: ContractField[] | null;
  shape: ContractShape | null;
  /** Index signature for interface schemas with patternProperties or additionalProperties. */
  index?: ContractShape | null;
  docs?: DocBlock;
  source?: SourceRef;
}

export type ContractShape =
  | { kind: "schema"; schema: OpenAPISchema | undefined }
  | { kind: "primitive"; name: PrimitiveName };

export type PrimitiveName =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "void"
  | "unknown"
  | "never"
  | "Blob";

export interface DocBlock {
  summary?: string;
  description?: string;
  deprecated?: boolean;
}
