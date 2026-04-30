// src/ir/types.ts

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
  /** Default `${method.toUpperCase()} ${path}`; renderer may override per endpointKey option. */
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
  /** null → renderer outputs `unknown` */
  success: TypeNode | null;
  /** Always populated by builder; renderer outputs only if `errors: true`. */
  errors: ErrorResponse[];
}

export interface ErrorResponse {
  /** "400" / "4XX" / "5XX" / "503". `default` is NOT collected — see spec §3. */
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
