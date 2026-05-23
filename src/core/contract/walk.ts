import type {
  OpenAPIDocument,
  Components,
  PathItem,
  Operation,
  Parameter,
  RequestBody,
  Response,
  MediaType,
  OpenAPISchema,
} from "./openapi";
import { HTTP_METHODS } from "./openapi";

// A separate read-only walk lives in `discriminators.ts`; see docs/adr/0001 for why they
// aren't unified.
/**
 * Schema transformation callback used by document mapping helpers.
 *
 * Return the same schema object to preserve identity, or a replacement schema to
 * trigger structural sharing up the document tree.
 */
export type SchemaMapper = (schema: OpenAPISchema) => OpenAPISchema;

/**
 * Visitor hooks for shallow OpenAPI document nodes.
 *
 * Hook locations are JSON Pointer-like strings for diagnostics. When a hook
 * returns an object with `$ref`, child traversal stops for that node so unresolved
 * references are not treated as concrete objects.
 */
export interface DocumentVisitor {
  /** Visit path item objects in `paths`, `webhooks`, and `components.pathItems`. */
  pathItem?: (item: PathItem, location: string) => PathItem;
  /** Visit parameter objects before their schema child is visited. */
  parameter?: (param: Parameter, location: string) => Parameter;
  /** Visit request body objects before content schemas are visited. */
  requestBody?: (body: RequestBody, location: string) => RequestBody;
  /** Visit response objects before content schemas are visited. */
  response?: (resp: Response, location: string) => Response;
  /** Visit schema objects reachable through supported document locations. */
  schema?: (schema: OpenAPISchema, location: string) => OpenAPISchema;
}

/**
 * Map supported OpenAPI document nodes with structural sharing.
 *
 * The original object graph is reused when all visitors return the same objects.
 * Components, `paths`, and `webhooks` are walked; schema recursion is shallow
 * unless callers use `mapDocumentSchemas`.
 */
export function mapDocument(doc: OpenAPIDocument, visitor: DocumentVisitor): OpenAPIDocument {
  let out = doc;
  if (doc.components) {
    const next = mapComponents(doc.components, visitor);
    if (next !== doc.components) out = { ...out, components: next };
  }
  if (doc.paths) {
    const next = mapPathMap(doc.paths, visitor, "/paths");
    if (next !== doc.paths) out = { ...out, paths: next };
  }
  if (doc.webhooks) {
    const next = mapPathMap(doc.webhooks, visitor, "/webhooks");
    if (next !== doc.webhooks) out = { ...out, webhooks: next };
  }
  return out;
}

/**
 * Deep-map every supported schema in the document.
 *
 * `$ref` schema objects are left untouched. For non-ref schemas, nested
 * `properties`, `items`, `prefixItems`, `additionalProperties`, `oneOf`,
 * `anyOf`, and `allOf` schemas are mapped before the parent schema callback.
 */
export function mapDocumentSchemas(doc: OpenAPIDocument, mapSchema: SchemaMapper): OpenAPIDocument {
  return mapDocument(doc, {
    schema: (s) => mapSchemaDeep(s, mapSchema),
  });
}

function mapComponents(components: Components, visitor: DocumentVisitor): Components {
  let out = components;
  const schemaVisitor = visitor.schema;
  if (components.schemas && schemaVisitor) {
    const next = mapValuesIdentity(components.schemas, (s, name) =>
      schemaVisitor(s, `/components/schemas/${name}`),
    );
    if (next !== components.schemas) out = { ...out, schemas: next };
  }
  if (components.parameters) {
    const next = mapValuesIdentity(components.parameters, (p, name) =>
      mapParameter(p, visitor, `/components/parameters/${name}`),
    );
    if (next !== components.parameters) out = { ...out, parameters: next };
  }
  if (components.requestBodies) {
    const next = mapValuesIdentity(components.requestBodies, (b, name) =>
      mapRequestBody(b, visitor, `/components/requestBodies/${name}`),
    );
    if (next !== components.requestBodies) out = { ...out, requestBodies: next };
  }
  if (components.responses) {
    const next = mapValuesIdentity(components.responses, (r, name) =>
      mapResponse(r, visitor, `/components/responses/${name}`),
    );
    if (next !== components.responses) out = { ...out, responses: next };
  }
  return out;
}

function mapPathMap(
  paths: Record<string, PathItem>,
  visitor: DocumentVisitor,
  basePath: string,
): Record<string, PathItem> {
  return mapValuesIdentity(paths, (item, key) => mapPathItem(item, visitor, `${basePath}/${key}`));
}

function mapPathItem(item: PathItem, visitor: DocumentVisitor, location: string): PathItem {
  const visited = visitor.pathItem ? visitor.pathItem(item, location) : item;
  if (visited.$ref !== undefined) return visited;

  let out = visited;
  if (visited.parameters) {
    const next = mapArrayIdentity(visited.parameters, (p, i) =>
      mapParameter(p, visitor, `${location}/parameters[${i}]`),
    );
    if (next !== visited.parameters) out = { ...out, parameters: next };
  }
  for (const method of HTTP_METHODS) {
    const op = visited[method];
    if (!op) continue;
    const next = mapOperation(op, visitor, `${location}/${method}`);
    if (next !== op) out = { ...out, [method]: next };
  }
  return out;
}

function mapOperation(op: Operation, visitor: DocumentVisitor, location: string): Operation {
  let out = op;
  if (op.parameters) {
    const next = mapArrayIdentity(op.parameters, (p, i) =>
      mapParameter(p, visitor, `${location}/parameters[${i}]`),
    );
    if (next !== op.parameters) out = { ...out, parameters: next };
  }
  if (op.requestBody) {
    const next = mapRequestBody(op.requestBody, visitor, `${location}/requestBody`);
    if (next !== op.requestBody) out = { ...out, requestBody: next };
  }
  if (op.responses) {
    const next = mapValuesIdentity(op.responses, (r, code) =>
      mapResponse(r, visitor, `${location}/responses/${code}`),
    );
    if (next !== op.responses) out = { ...out, responses: next };
  }
  return out;
}

function mapParameter(p: Parameter, visitor: DocumentVisitor, location: string): Parameter {
  let current = visitor.parameter ? visitor.parameter(p, location) : p;
  if (current.$ref !== undefined) return current;
  if (current.schema && visitor.schema) {
    const next = visitor.schema(current.schema, `${location}/schema`);
    if (next !== current.schema) current = { ...current, schema: next };
  }
  return current;
}

function mapRequestBody(b: RequestBody, visitor: DocumentVisitor, location: string): RequestBody {
  let current = visitor.requestBody ? visitor.requestBody(b, location) : b;
  if (current.$ref !== undefined) return current;
  if (current.content) {
    const next = mapMediaContent(current.content, visitor, `${location}/content`);
    if (next !== current.content) current = { ...current, content: next };
  }
  return current;
}

function mapResponse(r: Response, visitor: DocumentVisitor, location: string): Response {
  let current = visitor.response ? visitor.response(r, location) : r;
  if (current.$ref !== undefined) return current;
  if (current.content) {
    const next = mapMediaContent(current.content, visitor, `${location}/content`);
    if (next !== current.content) current = { ...current, content: next };
  }
  return current;
}

function mapMediaContent(
  content: Record<string, MediaType>,
  visitor: DocumentVisitor,
  location: string,
): Record<string, MediaType> {
  const schemaVisitor = visitor.schema;
  if (!schemaVisitor) return content;
  return mapValuesIdentity(content, (media, ct) => {
    if (!media.schema) return media;
    const next = schemaVisitor(media.schema, `${location}/${ct}/schema`);
    return next === media.schema ? media : { ...media, schema: next };
  });
}

function mapSchemaDeep(schema: OpenAPISchema, mapSchema: SchemaMapper): OpenAPISchema {
  if (schema.$ref !== undefined) return schema;

  let next = schema;
  let changed = false;

  if (next.properties) {
    const newProps = mapValuesIdentity(next.properties, (v) => mapSchemaDeep(v, mapSchema));
    if (newProps !== next.properties) {
      next = { ...next, properties: newProps };
      changed = true;
    }
  }
  if (next.items && typeof next.items === "object") {
    const nextItems = mapSchemaDeep(next.items, mapSchema);
    if (nextItems !== next.items) {
      next = { ...next, items: nextItems };
      changed = true;
    }
  }
  if (next.prefixItems) {
    const nextItems = mapArrayIdentity(next.prefixItems, (item) => mapSchemaDeep(item, mapSchema));
    if (nextItems !== next.prefixItems) {
      next = { ...next, prefixItems: nextItems };
      changed = true;
    }
  }
  if (next.additionalProperties && typeof next.additionalProperties === "object") {
    const nextAP = mapSchemaDeep(next.additionalProperties, mapSchema);
    if (nextAP !== next.additionalProperties) {
      next = { ...next, additionalProperties: nextAP };
      changed = true;
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = next[key];
    if (branches) {
      const nextBranches = mapArrayIdentity(branches, (b) => mapSchemaDeep(b, mapSchema));
      if (nextBranches !== branches) {
        next = { ...next, [key]: nextBranches };
        changed = true;
      }
    }
  }

  const mapped = mapSchema(next);
  if (mapped !== next) return mapped;
  return changed ? next : schema;
}

function mapValuesIdentity<T>(
  obj: Record<string, T>,
  fn: (value: T, key: string) => T,
): Record<string, T> {
  let changed = false;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(obj)) {
    const next = fn(value, key);
    if (next !== value) changed = true;
    out[key] = next;
  }
  return changed ? out : obj;
}

function mapArrayIdentity<T>(arr: T[], fn: (value: T, index: number) => T): T[] {
  let changed = false;
  const out: T[] = arr.map((value, index) => {
    const next = fn(value, index);
    if (next !== value) changed = true;
    return next;
  });
  return changed ? out : arr;
}
