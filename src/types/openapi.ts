// src/types/openapi.ts

/**
 * Minimal OpenAPI 3.0/3.1 subset consumed by openapi-shape.
 * After loader/normalize.ts runs, 3.0 nullable on primitives is rewritten
 * to 3.1 type-array form. After loader/refs.ts runs, $ref siblings are gone.
 *
 * Fields that may carry $ref pre-resolution declare $ref as optional.
 * Other identifying fields (e.g., Parameter.name, Parameter.in) are also
 * optional so $ref-only siblings are type-legal.
 */

export interface OpenAPIDocument {
  openapi?: string;
  info?: Info;
  paths?: Record<string, PathItem>;
  components?: Components;
  webhooks?: Record<string, PathItem>;
}

export interface Info {
  title?: string;
  version?: string;
  description?: string;
}

export interface Components {
  schemas?: Record<string, OpenAPISchema>;
  parameters?: Record<string, Parameter>;
  requestBodies?: Record<string, RequestBody>;
  responses?: Record<string, Response>;
  pathItems?: Record<string, PathItem>;
}

export interface PathItem {
  $ref?: string;
  parameters?: Parameter[];
  get?: Operation;
  put?: Operation;
  post?: Operation;
  delete?: Operation;
  options?: Operation;
  head?: Operation;
  patch?: Operation;
  trace?: Operation;
}

export interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, Response>;
}

export interface Parameter {
  $ref?: string;
  name?: string;
  in?: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: OpenAPISchema;
  description?: string;
  deprecated?: boolean;
}

export interface RequestBody {
  $ref?: string;
  required?: boolean;
  content?: Record<string, MediaType>;
  description?: string;
}

export interface Response {
  $ref?: string;
  content?: Record<string, MediaType>;
  description?: string;
}

export interface MediaType {
  schema?: OpenAPISchema;
}

export interface Discriminator {
  propertyName: string;
  mapping?: Record<string, string>;
}

export interface OpenAPISchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;

  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  allOf?: OpenAPISchema[];

  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  additionalProperties?: boolean | OpenAPISchema;

  items?: OpenAPISchema | boolean;
  prefixItems?: OpenAPISchema[];

  discriminator?: Discriminator;

  /** 3.0; rewritten to type-array form by loader/normalize.ts */
  nullable?: boolean;

  description?: string;
  summary?: string;
  deprecated?: boolean;
}
