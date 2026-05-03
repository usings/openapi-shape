// Public package surface. Modules not exported here are internal and may change
// without a semver signal.
//
// Keep the loader API intentionally small: `loadDocument` for sources and
// `prepareDocument` for in-memory documents. Normalization, ref resolution, and
// discriminator injection remain implementation details.

// Main API
export { generate, type GenerateOptions } from "./generate";

// Loader
export { loadDocument, prepareDocument } from "./loader";

// Advanced pipeline
export { buildIR, type BuildOptions } from "./ir";
export { render, type RenderOptions } from "./render";

// IR types
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
} from "./ir";

// OpenAPI types
export type { OpenAPIDocument } from "./types/openapi";

// Errors
export { LoadError, BuildError } from "./errors";
