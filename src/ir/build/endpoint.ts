import type {
  OpenAPIDocument,
  Operation,
  Parameter,
  RequestBody,
  MediaType,
} from "../../types/openapi";
import type { EndpointModel, ParamGroup, BodyModel, HttpMethod, DocBlock } from "../types";
import { BuildError } from "../../errors";
import { schemaToTypeNode } from "./schema";
import { buildResponses, isJsonContentType } from "./response";
import type { BuildOptions } from "./index";

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

export function buildEndpoints(doc: OpenAPIDocument, options: BuildOptions): EndpointModel[] {
  const out: EndpointModel[] = [];
  const paths = doc.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathParams = pathItem.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (!op.responses) {
        throw new BuildError(`Operation is missing required responses`, `/paths/${path}/${method}`);
      }
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

function docBlockFromParameter(p: Parameter): DocBlock | undefined {
  const out: DocBlock = {};
  if (p.description) out.description = p.description;
  if (p.deprecated) out.deprecated = true;
  return Object.keys(out).length === 0 ? undefined : out;
}
