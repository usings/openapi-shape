export interface IR {
  info: DocumentInfo;
  schemas: SchemaModel[];
  endpoints: EndpointModel[];
}

export interface DocumentInfo {
  title?: string;
  version?: string;
  description?: string;
}

export type HttpMethod = "get" | "post" | "put" | "delete" | "patch" | "head" | "options" | "trace";

export interface EndpointModel {
  /** Stable endpoint key used when renderers do not choose another key strategy. */
  key: string;
  method: HttpMethod;
  path: string;

  operationId?: string;
  tags: string[];
  summary?: string;
  description?: string;
  deprecated: boolean;

  params: ParamGroup;
  query: ParamGroup;
  body: BodyModel;
  responses: ResponseGroup;
}

export interface ParamGroup {
  fields: FieldModel[];
}

export interface FieldModel {
  name: string;
  required: boolean;
  type: TypeNode;
  docs?: DocBlock;
}

export interface BodyModel {
  kind: "none" | "json" | "passthrough";
  required: boolean;
  type: TypeNode | null;
}

export interface ResponseGroup {
  /** Missing success payload; renderers usually emit `unknown`. */
  success: TypeNode | null;
  /** Collected for all builds; renderers may choose whether to emit it. */
  errors: ErrorResponse[];
}

export interface ErrorResponse {
  /** Explicit 4xx/5xx status or OpenAPI range such as "4XX"; `default` is excluded. */
  status: string;
  type: TypeNode;
}

export interface SchemaModel {
  /** Sanitized TS identifier. */
  name: string;
  /** Original OpenAPI schema name. */
  originalName: string;
  kind: "interface" | "alias";
  fields: FieldModel[] | null;
  type: TypeNode | null;
  docs?: DocBlock;
}

export type TypeNode =
  | { kind: "primitive"; name: PrimitiveName }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "ref"; name: string }
  | { kind: "array"; items: TypeNode }
  | { kind: "tuple"; items: TypeNode[]; rest: TypeNode | null }
  | { kind: "object"; fields: FieldModel[]; index: TypeNode | null }
  | { kind: "record"; values: TypeNode }
  | { kind: "union"; members: TypeNode[] }
  | { kind: "intersection"; members: TypeNode[] }
  | { kind: "raw"; text: string };

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
