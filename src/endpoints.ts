import { schemaToType } from "./schemas";
import { indent, indentContinuation, jsdoc, safeKey } from "./helpers";

function findResponseType(responses: any): string {
  if (!responses) return "unknown";
  let sawSuccessNoContent = false;
  for (const code of Object.keys(responses)) {
    if (!/^2\d{2}$|^2XX$/.test(code)) continue;
    const r = responses[code];
    if (!r?.content) {
      sawSuccessNoContent = true;
      continue;
    }
    const t = extractResponseType(r);
    if (t) return t;
  }
  if (sawSuccessNoContent) return "void";
  if (responses.default?.content) {
    const t = extractResponseType(responses.default);
    if (t) return t;
  }
  return "unknown";
}

function isBinaryContentType(contentType: string): boolean {
  return (
    contentType === "application/octet-stream" ||
    contentType === "application/pdf" ||
    contentType === "application/zip" ||
    contentType.startsWith("image/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/")
  );
}

function isBinarySchema(schema: any): boolean {
  return schema?.format === "binary" || schema?.format === "byte";
}

function extractResponseType(response: any): string | null {
  const content = response?.content;
  if (!content) return null;

  for (const contentType of Object.keys(content)) {
    if (contentType.includes("json") && content[contentType].schema) {
      return schemaToType(content[contentType].schema);
    }
  }

  for (const contentType of Object.keys(content)) {
    if (isBinaryContentType(contentType) || isBinarySchema(content[contentType].schema)) {
      return "Blob";
    }
  }

  for (const contentType of Object.keys(content)) {
    if (contentType.startsWith("text/")) {
      return "string";
    }
  }

  for (const contentType of Object.keys(content)) {
    if (content[contentType].schema) {
      return schemaToType(content[contentType].schema);
    }
  }

  if (Object.keys(content).length > 0) {
    return "Blob";
  }

  return null;
}

function findContentSchema(content: Record<string, any>): any | undefined {
  for (const contentType of Object.keys(content)) {
    if (contentType.includes("json") && content[contentType].schema) {
      return content[contentType].schema;
    }
  }

  for (const contentType of Object.keys(content)) {
    if (content[contentType].schema) {
      return content[contentType].schema;
    }
  }

  return undefined;
}

function deduplicateParams(params: any[]): any[] {
  const seen = new Map<string, any>();
  for (const parameter of params) {
    seen.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...seen.values()];
}

function hasDocs(items: any[]): boolean {
  return items.some((item) => item.description || item.deprecated);
}

function buildObjectShape(items: any[], renderField: (item: any) => string): string {
  if (hasDocs(items)) {
    const fields = items.map((item) => `${jsdoc(item)}${renderField(item)}`).join("\n");
    return `{\n${indent(fields)}\n}`;
  }
  return `{ ${items.map(renderField).join("; ")} }`;
}

function buildParams(parameters: any[]): string {
  const pathParams = parameters.filter((parameter: any) => parameter.in === "path");
  if (pathParams.length === 0) return "void";
  return buildObjectShape(pathParams, (parameter) => `${safeKey(parameter.name)}: string`);
}

function buildQuery(parameters: any[]): string {
  const queryParams = parameters.filter((parameter: any) => parameter.in === "query");
  if (queryParams.length === 0) return "void";
  return buildObjectShape(queryParams, (parameter) => {
    const optionalToken = parameter.required ? "" : "?";
    return `${safeKey(parameter.name)}${optionalToken}: ${schemaToType(parameter.schema)}`;
  });
}

function buildRequestType(operation: any): { type: string; required: boolean } {
  const requestBody = operation?.requestBody;
  if (!requestBody?.content) return { type: "void", required: true };

  const schema = findContentSchema(requestBody.content);
  if (schema) {
    return { type: schemaToType(schema), required: requestBody.required === true };
  }

  return { type: "void", required: true };
}

export function generateEndpoints(paths: Record<string, any>): string {
  const entries: string[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    const pathLevelParams: any[] = pathItem.parameters || [];

    for (const [method, operation] of Object.entries<any>(pathItem)) {
      if (!operation?.responses) continue;

      const endpointKey = `${method.toUpperCase()} ${path}`;
      const operationParams: any[] = operation.parameters || [];
      const allParams = deduplicateParams([...pathLevelParams, ...operationParams]);

      const params = buildParams(allParams);
      const query = buildQuery(allParams);
      const { type: bodyType, required: bodyRequired } = buildRequestType(operation);
      const response = findResponseType(operation.responses);

      const bodyLine =
        bodyType === "void"
          ? `body: void`
          : bodyRequired
            ? `body: ${indentContinuation(bodyType, "    ")}`
            : `body?: ${indentContinuation(bodyType, "    ")}`;

      const endpointDoc = jsdoc(operation, "  ");
      entries.push(
        `${endpointDoc}  "${endpointKey}": {\n` +
          `    params: ${indentContinuation(params, "    ")}\n` +
          `    query: ${indentContinuation(query, "    ")}\n` +
          `    ${bodyLine}\n` +
          `    response: ${indentContinuation(response, "    ")}\n` +
          `  }`,
      );
    }
  }

  return `export interface Endpoints {\n${entries.join("\n")}\n}`;
}
