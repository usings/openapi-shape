import type { ContractShape, ContractOutcomes, ErrorResponse } from "./contract";
import type { OpenAPISchema, MediaType, Response } from "./openapi";
import { primitiveShape, schemaShape } from "./shapes";

export function buildResponses(responses: Record<string, Response>): ContractOutcomes {
  const success = pickSuccess(responses);
  return {
    success: success?.shape ?? null,
    successStatus: success?.status,
    successContentType: success?.contentType,
    errors: collectErrors(responses),
  };
}

export function isJsonContentType(ct: string): boolean {
  return ct.toLowerCase().includes("json");
}

interface ResponseTypeMatch {
  status: string;
  shape: ContractShape;
  contentType?: string;
}

function pickSuccess(responses: Record<string, Response>): ResponseTypeMatch | null {
  let successNoContentStatus: string | null = null;
  for (const code of Object.keys(responses)) {
    if (!/^2\d{2}$|^2XX$/.test(code)) continue;
    const r = responses[code];
    if (!r?.content) {
      successNoContentStatus ??= code;
      continue;
    }
    const match = extractResponseType(r.content);
    if (match) return { status: code, ...match };
  }
  if (successNoContentStatus) {
    return { status: successNoContentStatus, shape: primitiveShape("void") };
  }
  if (responses.default?.content) {
    const match = extractResponseType(responses.default.content);
    if (match) return { status: "default", ...match };
  }
  return null;
}

function collectErrors(responses: Record<string, Response>): ErrorResponse[] {
  const out: ErrorResponse[] = [];
  const codes = Object.keys(responses)
    .filter((code) => /^4\d{2}$|^5\d{2}$|^4XX$|^5XX$/.test(code))
    .toSorted((a, b) => errorCodeSortKey(a) - errorCodeSortKey(b));
  for (const code of codes) {
    const r = responses[code];
    if (!r?.content) continue;
    const match = extractResponseType(r.content);
    if (match) {
      out.push({
        status: code,
        shape: match.shape,
        contentType: match.contentType,
        source: { location: `/responses/${code}` },
      });
    }
  }
  return out;
}

function errorCodeSortKey(code: string): number {
  if (/^\d{3}$/.test(code)) return parseInt(code, 10);
  if (code === "4XX") return 450;
  if (code === "5XX") return 550;
  return 999;
}

function extractResponseType(content: Record<string, MediaType>): {
  shape: ContractShape;
  contentType?: string;
} | null {
  for (const ct of Object.keys(content)) {
    if (isJsonContentType(ct) && content[ct].schema) {
      return { shape: schemaShape(content[ct].schema), contentType: ct };
    }
  }
  for (const ct of Object.keys(content)) {
    if (isBinaryContentType(ct) || isBinarySchema(content[ct].schema)) {
      return { shape: primitiveShape("Blob"), contentType: ct };
    }
  }
  for (const ct of Object.keys(content)) {
    if (ct.toLowerCase().startsWith("text/")) {
      return { shape: primitiveShape("string"), contentType: ct };
    }
  }
  for (const ct of Object.keys(content)) {
    if (content[ct].schema) {
      return { shape: schemaShape(content[ct].schema), contentType: ct };
    }
  }
  const firstContentType = Object.keys(content)[0];
  if (firstContentType) return { shape: primitiveShape("Blob"), contentType: firstContentType };
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
  return s !== undefined && (s.format === "binary" || s.format === "byte");
}
