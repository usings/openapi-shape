/**
 * Minimal OpenAPI 3.0/3.1 model consumed by openapi-shape.
 *
 * Loader stages prepare this shape before IR building:
 * - 3.0 primitive `nullable` schemas become 3.1 type arrays.
 * - Supported component `$ref`s are resolved before rendering.
 *
 * Fields that may carry $ref pre-resolution declare $ref as optional.
 * Identifying fields such as Parameter.name and Parameter.in stay optional so
 * pre-resolution `$ref` placeholders remain type-legal.
 */

export type HttpMethod = "get" | "post" | "put" | "delete" | "patch" | "head" | "options" | "trace";

export const HTTP_METHODS: HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

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

  /** OpenAPI 3.0 nullable marker; normalized to 3.1 type arrays. */
  nullable?: boolean;

  description?: string;
  summary?: string;
  deprecated?: boolean;
}
