import type { OpenAPIDocument } from "../load/openapi";
import type { IR } from "./ir";
import { buildSchemas } from "./schemas";
import { buildEndpoints } from "./endpoint";

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
