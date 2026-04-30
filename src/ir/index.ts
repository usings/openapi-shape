// src/ir/index.ts
export type {
  IR,
  EndpointModel,
  SchemaModel,
  TypeNode,
  PrimitiveName,
  FieldModel,
  ParamGroup,
  BodyModel,
  ResponseGroup,
  ErrorResponse,
  DocumentInfo,
  DocBlock,
  HttpMethod,
} from "./types";
export { buildIR } from "./build";
export type { BuildOptions } from "./build";
