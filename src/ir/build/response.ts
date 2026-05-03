import type { OpenAPISchema, MediaType, Response } from "../../types/openapi";
import type { TypeNode, ResponseGroup, ErrorResponse } from "../types";
import { schemaToTypeNode, primitive } from "./schema";
import type { BuildOptions } from "./index";

export function buildResponses(
  responses: Record<string, Response>,
  options: BuildOptions,
): ResponseGroup {
  return {
    success: pickSuccess(responses, options),
    errors: collectErrors(responses, options),
  };
}

export function isJsonContentType(ct: string): boolean {
  return ct.toLowerCase().includes("json");
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

function errorCodeSortKey(code: string): number {
  if (/^\d{3}$/.test(code)) return parseInt(code, 10);
  if (code === "4XX") return 450;
  if (code === "5XX") return 550;
  return 999;
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
