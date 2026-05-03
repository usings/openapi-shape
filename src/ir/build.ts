import type {
  OpenAPIDocument,
  OpenAPISchema,
  Operation,
  Parameter,
  RequestBody,
  Response,
  MediaType,
} from "../types/openapi";
import type {
  IR,
  SchemaModel,
  EndpointModel,
  TypeNode,
  PrimitiveName,
  FieldModel,
  ParamGroup,
  BodyModel,
  ResponseGroup,
  ErrorResponse,
  HttpMethod,
  DocBlock,
} from "./types";
import { BuildError } from "../errors";
import { safeIdentifier } from "../naming";

export interface BuildOptions {
  formats?: Record<string, string>;
}

export function buildIR(doc: OpenAPIDocument, options: BuildOptions = {}): IR {
  return {
    info: buildInfo(doc),
    schemas: buildSchemas(doc, options),
    endpoints: buildEndpoints(doc, options),
  };
}

function buildInfo(doc: OpenAPIDocument): IR["info"] {
  const info = doc.info ?? {};
  const out: IR["info"] = {};
  if (typeof info.title === "string" && info.title.trim()) out.title = info.title.trim();
  if (typeof info.version === "string" && info.version.trim()) out.version = info.version.trim();
  if (typeof info.description === "string" && info.description.trim())
    out.description = info.description.trim();
  return out;
}

function buildSchemas(doc: OpenAPIDocument, options: BuildOptions): SchemaModel[] {
  const raw = doc.components?.schemas;
  if (!raw) return [];

  const sanitizedToOriginal = new Map<string, string>();
  for (const name of Object.keys(raw)) {
    const sanitized = safeIdentifier(name);
    const prior = sanitizedToOriginal.get(sanitized);
    if (prior !== undefined && prior !== name) {
      throw new BuildError(
        `Schema name collision after sanitization: "${prior}" and "${name}" both → "${sanitized}"`,
        `/components/schemas`,
      );
    }
    sanitizedToOriginal.set(sanitized, name);
  }

  const result: SchemaModel[] = [];
  for (const [originalName, schema] of Object.entries(raw)) {
    const name = safeIdentifier(originalName);
    if (schema.type === "object" && schema.properties) {
      const required = new Set<string>(schema.required ?? []);
      const fields: FieldModel[] = Object.entries(schema.properties).map(([fname, fschema]) => ({
        name: fname,
        required: required.has(fname),
        type: schemaToTypeNode(fschema, options),
        docs: docBlock(fschema),
      }));
      result.push({
        name,
        originalName,
        kind: "interface",
        fields,
        type: null,
        docs: docBlock(schema),
      });
    } else {
      result.push({
        name,
        originalName,
        kind: "alias",
        fields: null,
        type: schemaToTypeNode(schema, options),
        docs: docBlock(schema),
      });
    }
  }
  return result;
}

// Schema conversion

function schemaToTypeNode(schema: OpenAPISchema | undefined, options: BuildOptions): TypeNode {
  if (!schema || isEmptySchema(schema)) return primitive("unknown");

  if ("const" in schema) return constToTypeNode(schema.const);

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return primitive("never");
    return uniqueUnion(schema.enum.map((v) => constToTypeNode(v)));
  }

  if (schema.$ref) {
    const parts = schema.$ref.split("/");
    return { kind: "ref", name: safeIdentifier(parts[parts.length - 1]) };
  }

  if (schema.oneOf) {
    if (schema.oneOf.length === 0) return primitive("never");
    return uniqueUnion(schema.oneOf.map((b) => schemaToTypeNode(b, options)));
  }
  if (schema.anyOf) {
    if (schema.anyOf.length === 0) return primitive("never");
    return uniqueUnion(schema.anyOf.map((b) => schemaToTypeNode(b, options)));
  }
  if (schema.allOf) {
    return {
      kind: "intersection",
      members: schema.allOf.map((b) => schemaToTypeNode(b, options)),
    };
  }

  if (Array.isArray(schema.type)) return typeArrayToNode(schema, options);

  return convertSingleType(schema, options);
}

function isEmptySchema(s: OpenAPISchema): boolean {
  return (
    s.type === undefined &&
    !s.$ref &&
    !s.oneOf &&
    !s.anyOf &&
    !s.allOf &&
    !s.enum &&
    !("const" in s)
  );
}

function typeArrayToNode(schema: OpenAPISchema, options: BuildOptions): TypeNode {
  const types = schema.type as string[];
  const nonNull = types.filter((t) => t !== "null");
  const includesNull = types.includes("null");

  if (
    schema.format !== undefined &&
    options.formats &&
    Object.prototype.hasOwnProperty.call(options.formats, schema.format) &&
    nonNull.length === 1 &&
    isFormatMappablePrimitive(nonNull[0])
  ) {
    const mapped: TypeNode = { kind: "raw", text: options.formats[schema.format] };
    return includesNull ? { kind: "union", members: [mapped, primitive("null")] } : mapped;
  }

  const inner: TypeNode[] = nonNull.map((t) => primitiveStringToNode(t));
  if (includesNull) inner.push(primitive("null"));
  if (inner.length === 1) return inner[0];
  return { kind: "union", members: inner };
}

function convertSingleType(schema: OpenAPISchema, options: BuildOptions): TypeNode {
  const t = typeof schema.type === "string" ? schema.type : undefined;

  if (
    schema.format !== undefined &&
    options.formats &&
    Object.prototype.hasOwnProperty.call(options.formats, schema.format) &&
    (t === undefined || isFormatMappablePrimitive(t))
  ) {
    return { kind: "raw", text: options.formats[schema.format] };
  }

  if (
    (t === "string" || t === undefined) &&
    (schema.format === "binary" || schema.format === "byte")
  ) {
    return primitive("Blob");
  }

  if (t === "array") return arrayToNode(schema, options);
  if (t === "object") return objectToNode(schema, options);
  if (t === undefined) return primitive("unknown");
  return primitiveStringToNode(t);
}

function arrayToNode(schema: OpenAPISchema, options: BuildOptions): TypeNode {
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((it) => schemaToTypeNode(it, options));
    let rest: TypeNode | null = null;
    if (schema.items === true) rest = primitive("unknown");
    else if (schema.items && typeof schema.items === "object")
      rest = schemaToTypeNode(schema.items, options);
    return { kind: "tuple", items, rest };
  }
  const items =
    typeof schema.items === "object" && schema.items !== null
      ? schemaToTypeNode(schema.items, options)
      : primitive("unknown");
  return { kind: "array", items };
}

function objectToNode(schema: OpenAPISchema, options: BuildOptions): TypeNode {
  if (!schema.properties && isObjectAdditional(schema.additionalProperties)) {
    return { kind: "record", values: schemaToTypeNode(schema.additionalProperties, options) };
  }
  if (!schema.properties) {
    return { kind: "record", values: primitive("unknown") };
  }
  const required = new Set<string>(schema.required ?? []);
  const fields: FieldModel[] = Object.entries(schema.properties).map(([name, value]) => ({
    name,
    required: required.has(name),
    type: schemaToTypeNode(value, options),
    docs: docBlock(value),
  }));
  let index: TypeNode | null = null;
  if (isObjectAdditional(schema.additionalProperties)) {
    index = schemaToTypeNode(schema.additionalProperties, options);
  }
  return { kind: "object", fields, index };
}

function isObjectAdditional(v: unknown): v is OpenAPISchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFormatMappablePrimitive(t: string): boolean {
  return t === "string" || t === "number" || t === "integer";
}

function primitive(name: PrimitiveName): TypeNode {
  return { kind: "primitive", name };
}

function primitiveStringToNode(t: string): TypeNode {
  switch (t) {
    case "string":
      return primitive("string");
    case "number":
    case "integer":
      return primitive("number");
    case "boolean":
      return primitive("boolean");
    case "null":
      return primitive("null");
    default:
      return primitive("unknown");
  }
}

function constToTypeNode(value: unknown): TypeNode {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return { kind: "literal", value };
  }
  return primitive("unknown");
}

function uniqueUnion(members: TypeNode[]): TypeNode {
  const seen = new Set<string>();
  const dedup: TypeNode[] = [];
  for (const m of members) {
    const key = JSON.stringify(m);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(m);
  }
  if (dedup.length === 1) return dedup[0];
  return { kind: "union", members: dedup };
}

function docBlock(s: OpenAPISchema | undefined): DocBlock | undefined {
  if (!s) return undefined;
  const out: DocBlock = {};
  if (s.summary) out.summary = s.summary;
  if (s.description) out.description = s.description;
  if (s.deprecated) out.deprecated = true;
  return Object.keys(out).length === 0 ? undefined : out;
}

// Endpoint building

const HTTP_METHODS: HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

function buildEndpoints(doc: OpenAPIDocument, options: BuildOptions): EndpointModel[] {
  const out: EndpointModel[] = [];
  const paths = doc.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathParams = pathItem.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || !op.responses) continue;
      out.push(buildEndpoint(method, path, pathParams, op, options));
    }
  }
  return out;
}

function buildEndpoint(
  method: HttpMethod,
  path: string,
  pathParams: Parameter[],
  op: Operation,
  options: BuildOptions,
): EndpointModel {
  const merged = mergeParameters(pathParams, op.parameters ?? []);
  return {
    key: `${method.toUpperCase()} ${path}`,
    method,
    path,
    operationId: op.operationId,
    tags: op.tags ?? [],
    summary: op.summary,
    description: op.description,
    deprecated: op.deprecated === true,
    params: buildParams(merged),
    query: buildQuery(merged, options),
    body: buildBody(op.requestBody, options),
    responses: buildResponses(op.responses ?? {}, options),
  };
}

function mergeParameters(a: Parameter[], b: Parameter[]): Parameter[] {
  const seen = new Map<string, Parameter>();
  for (const p of [...a, ...b]) {
    if (typeof p.in !== "string" || typeof p.name !== "string") continue;
    seen.set(`${p.in}:${p.name}`, p);
  }
  return [...seen.values()];
}

function buildParams(parameters: Parameter[]): ParamGroup {
  return {
    fields: parameters
      .filter((p) => p.in === "path")
      .map((p) => ({
        name: p.name as string,
        required: true,
        type: { kind: "primitive", name: "string" } as const,
        docs: docBlockFromParameter(p),
      })),
  };
}

function buildQuery(parameters: Parameter[], options: BuildOptions): ParamGroup {
  return {
    fields: parameters
      .filter((p) => p.in === "query")
      .map((p) => ({
        name: p.name as string,
        required: p.required === true,
        type: schemaToTypeNode(p.schema, options),
        docs: docBlockFromParameter(p),
      })),
  };
}

function buildBody(rb: RequestBody | undefined, options: BuildOptions): BodyModel {
  if (!rb?.content) return { kind: "none", required: true, type: null };
  const required = rb.required === true;
  for (const [ct, media] of Object.entries(rb.content)) {
    if (isJsonContentType(ct) && (media as MediaType).schema) {
      return {
        kind: "json",
        required,
        type: schemaToTypeNode((media as MediaType).schema, options),
      };
    }
  }
  for (const [, media] of Object.entries(rb.content)) {
    if ((media as MediaType).schema) {
      return {
        kind: "passthrough",
        required,
        type: schemaToTypeNode((media as MediaType).schema, options),
      };
    }
  }
  return { kind: "none", required: true, type: null };
}

function buildResponses(responses: Record<string, Response>, options: BuildOptions): ResponseGroup {
  return {
    success: pickSuccess(responses, options),
    errors: collectErrors(responses, options),
  };
}

function pickSuccess(responses: Record<string, Response>, options: BuildOptions): TypeNode | null {
  let sawSuccessNoContent = false;
  for (const code of Object.keys(responses)) {
    if (!/^2\d{2}$|^2XX$/.test(code)) continue;
    const r = responses[code];
    if (!r?.content) {
      sawSuccessNoContent = true;
      continue;
    }
    const t = extractResponseType(r.content, options);
    if (t) return t;
  }
  if (sawSuccessNoContent) return primitive("void");
  if (responses.default?.content) {
    const t = extractResponseType(responses.default.content, options);
    if (t) return t;
  }
  return null;
}

function errorCodeSortKey(code: string): number {
  if (/^\d{3}$/.test(code)) return parseInt(code, 10);
  if (code === "4XX") return 450;
  if (code === "5XX") return 550;
  return 999;
}

function collectErrors(
  responses: Record<string, Response>,
  options: BuildOptions,
): ErrorResponse[] {
  const out: ErrorResponse[] = [];
  const codes = Object.keys(responses)
    .filter((code) => /^4\d{2}$|^5\d{2}$|^4XX$|^5XX$/.test(code))
    .sort((a, b) => errorCodeSortKey(a) - errorCodeSortKey(b));
  for (const code of codes) {
    const r = responses[code];
    if (!r?.content) continue;
    const t = extractResponseType(r.content, options);
    if (t) out.push({ status: code, type: t });
  }
  return out;
}

function extractResponseType(
  content: Record<string, MediaType>,
  options: BuildOptions,
): TypeNode | null {
  for (const ct of Object.keys(content)) {
    if (isJsonContentType(ct) && content[ct].schema) {
      return schemaToTypeNode(content[ct].schema, options);
    }
  }
  for (const ct of Object.keys(content)) {
    if (isBinaryContentType(ct) || isBinarySchema(content[ct].schema)) {
      return primitive("Blob");
    }
  }
  for (const ct of Object.keys(content)) {
    if (ct.toLowerCase().startsWith("text/")) return primitive("string");
  }
  for (const ct of Object.keys(content)) {
    if (content[ct].schema) return schemaToTypeNode(content[ct].schema, options);
  }
  if (Object.keys(content).length > 0) return primitive("Blob");
  return null;
}

function isJsonContentType(ct: string): boolean {
  return ct.toLowerCase().includes("json");
}

function isBinaryContentType(ct: string): boolean {
  const c = ct.toLowerCase();
  return (
    c === "application/octet-stream" ||
    c === "application/pdf" ||
    c === "application/zip" ||
    c.startsWith("image/") ||
    c.startsWith("audio/") ||
    c.startsWith("video/")
  );
}

function isBinarySchema(s: OpenAPISchema | undefined): boolean {
  return !!s && (s.format === "binary" || s.format === "byte");
}

function docBlockFromParameter(p: Parameter): DocBlock | undefined {
  const out: DocBlock = {};
  if (p.description) out.description = p.description;
  if (p.deprecated) out.deprecated = true;
  return Object.keys(out).length === 0 ? undefined : out;
}
