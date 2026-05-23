import type { ContractShape, ContractOutcome } from "./contract";
import type { OpenAPISchema, MediaType, Response } from "./openapi";
import { primitiveShape, schemaShape } from "./shapes";

export function buildResponses(responses: Record<string, Response>): ContractOutcome[] {
  const out: ContractOutcome[] = [];
  for (const [status, response] of Object.entries(responses)) {
    const { shape, contentType } = pickResponseShape(response);
    out.push({
      status,
      shape,
      ...(contentType !== undefined ? { contentType } : {}),
      source: { location: `/responses/${status}` },
    });
  }
  return out;
}

export function isJsonContentType(ct: string): boolean {
  return ct.toLowerCase().includes("json");
}

function pickResponseShape(response: Response | undefined): {
  shape: ContractShape;
  contentType?: string;
} {
  if (!response?.content) return { shape: primitiveShape("void") };
  return extractResponseType(response.content) ?? { shape: primitiveShape("void") };
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
