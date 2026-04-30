// src/index.ts
//
// Public package surface. Anything NOT re-exported here is a private
// implementation detail and may be moved or removed in future versions.
//
// Public Loader API: `loadDocument` + `prepareDocument` only. The internal
// seams `normalize` / `resolveRefs` / `injectDiscriminators` are deliberately
// not re-exported. The public name `loadDocument` mirrors `prepareDocument`
// and reads as "load a prepared OpenAPI document"; bare `load` would be too
// generic at the package boundary.

// Top-level
export { generate, generateFromSource, type GenerateOptions } from "./generate";

// Loader (public surface only)
export { loadDocument, prepareDocument } from "./loader";

// IR + render (advanced)
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
