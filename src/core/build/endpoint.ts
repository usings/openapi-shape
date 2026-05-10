import type {
  OpenAPIDocument,
  Operation,
  Parameter,
  PathItem,
  RequestBody,
  MediaType,
  HttpMethod,
} from "../load/openapi";
import { HTTP_METHODS } from "../load/openapi";
import { escapePointerSegment } from "../shared/pointer";
import { BuildError } from "./errors";
import type { BuildOptions } from "./index";
import type { EndpointModel, ParamGroup, BodyModel, DocBlock } from "./ir";
import { buildResponses, isJsonContentType } from "./response";
import { schemaToTypeNode } from "./type-node";

export function buildEndpoints(doc: OpenAPIDocument, options: BuildOptions): EndpointModel[] {
  return walkPathItems(doc.paths ?? {}, "/paths", options);
}

export function walkPathItems(
  items: Record<string, PathItem>,
  base: string,
  options: BuildOptions,
): EndpointModel[] {
  const out: EndpointModel[] = [];
  for (const [path, pathItem] of Object.entries(items)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathParams = pathItem.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (!op.responses) {
        throw new BuildError(
          `Operation is missing required responses at ${base}/${path}/${method}`,
        );
      }
      out.push(buildEndpoint(method, path, pathParams, op, options, base));
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
  base: string,
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
    headers: buildHeaders(merged),
    body: buildBody(op.requestBody, options),
    responses: buildResponses(op.responses ?? {}, options),
    source: { location: `${base}/${escapePointerSegment(path)}/${method}` },
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

function buildHeaders(parameters: Parameter[]): ParamGroup {
  return {
    fields: parameters
      .filter((p) => p.in === "header")
      .map((p) => ({
        name: p.name as string,
        required: p.required === true,
        type: { kind: "primitive", name: "string" },
        docs: docBlockFromParameter(p),
      })),
  };
}

function buildBody(rb: RequestBody | undefined, options: BuildOptions): BodyModel {
  if (!rb?.content) return { kind: "none" };
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
  return { kind: "none" };
}

function docBlockFromParameter(p: Parameter): DocBlock | undefined {
  const out: DocBlock = {};
  if (p.description) out.description = p.description;
  if (p.deprecated) out.deprecated = true;
  return Object.keys(out).length === 0 ? undefined : out;
}
