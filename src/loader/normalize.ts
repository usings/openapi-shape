// src/loader/normalize.ts
import type { OpenAPIDocument } from "../types/openapi";
import { LoadError } from "../errors";

/**
 * Read openapi version field; dispatch to per-version normalizer.
 * Missing version → assume 3.1 (passthrough). This file is allowed
 * to use `any` per oxlint override — it's the typed boundary.
 */
export function normalize(raw: unknown): OpenAPIDocument {
  if (raw === null || typeof raw !== "object") {
    throw new LoadError("OpenAPI document must be an object");
  }
  const doc = raw as Record<string, unknown>;
  const version = typeof doc.openapi === "string" ? doc.openapi : "";

  if (version === "" || /^3\.1\.\d+$/.test(version)) {
    return walkDocument(doc, (s) => s) as OpenAPIDocument;
  }
  if (/^3\.0\.\d+$/.test(version)) {
    return walkDocument(doc, rewrite30Schema) as OpenAPIDocument;
  }
  throw new LoadError(`Unsupported OpenAPI version: ${version}. Supported: 3.0.x, 3.1.x.`);
}

function walkDocument(
  doc: Record<string, unknown>,
  rewrite: (schema: any) => any,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc };

  if (doc.components && typeof doc.components === "object") {
    out.components = walkComponents(doc.components as Record<string, unknown>, rewrite);
  }

  if (doc.paths && typeof doc.paths === "object") {
    out.paths = walkPaths(doc.paths as Record<string, unknown>, rewrite);
  }

  return out;
}

function walkComponents(
  components: Record<string, unknown>,
  rewrite: (schema: any) => any,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...components };

  if (components.schemas && typeof components.schemas === "object") {
    const newSchemas: Record<string, unknown> = {};
    let changed = false;
    for (const [name, schema] of Object.entries(components.schemas as Record<string, any>)) {
      const next = walkSchema(schema, rewrite);
      newSchemas[name] = next;
      if (next !== schema) changed = true;
    }
    if (changed) out.schemas = newSchemas;
  }

  if (components.parameters && typeof components.parameters === "object") {
    out.parameters = mapValues(components.parameters as Record<string, unknown>, (p) =>
      walkParameter(p, rewrite),
    );
  }
  if (components.requestBodies && typeof components.requestBodies === "object") {
    out.requestBodies = mapValues(components.requestBodies as Record<string, unknown>, (b) =>
      walkBody(b, rewrite),
    );
  }
  if (components.responses && typeof components.responses === "object") {
    out.responses = mapValues(components.responses as Record<string, unknown>, (b) =>
      walkBody(b, rewrite),
    );
  }

  return out;
}

function walkPaths(
  paths: Record<string, unknown>,
  rewrite: (schema: any) => any,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(paths)) {
    out[k] = v && typeof v === "object" ? walkPathItem(v as Record<string, unknown>, rewrite) : v;
  }
  return out;
}

function walkPathItem(
  pi: Record<string, unknown>,
  rewrite: (schema: any) => any,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...pi };

  if (Array.isArray(pi.parameters)) {
    out.parameters = pi.parameters.map((p) => walkParameter(p, rewrite));
  }

  for (const m of ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const) {
    if (pi[m] && typeof pi[m] === "object") {
      out[m] = walkOperation(pi[m] as Record<string, unknown>, rewrite);
    }
  }

  return out;
}

function walkOperation(
  op: Record<string, unknown>,
  rewrite: (schema: any) => any,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...op };

  if (Array.isArray(op.parameters)) {
    out.parameters = op.parameters.map((p) => walkParameter(p, rewrite));
  }
  if (op.requestBody && typeof op.requestBody === "object") {
    out.requestBody = walkBody(op.requestBody, rewrite);
  }
  if (op.responses && typeof op.responses === "object") {
    out.responses = mapValues(op.responses as Record<string, unknown>, (r) => walkBody(r, rewrite));
  }

  return out;
}

function walkParameter(p: any, rewrite: (schema: any) => any): any {
  if (!p || typeof p !== "object" || p.$ref) return p;
  if (!p.schema) return p;
  const next = walkSchema(p.schema, rewrite);
  return next === p.schema ? p : { ...p, schema: next };
}

function walkBody(body: any, rewrite: (schema: any) => any): any {
  if (!body || typeof body !== "object" || body.$ref) return body;
  if (!body.content || typeof body.content !== "object") return body;
  let changed = false;
  const newContent: Record<string, any> = {};
  for (const [ct, media] of Object.entries(body.content)) {
    if (!media || typeof media !== "object" || !(media as any).schema) {
      newContent[ct] = media;
      continue;
    }
    const ns = walkSchema((media as any).schema, rewrite);
    if (ns !== (media as any).schema) {
      changed = true;
      newContent[ct] = { ...(media as any), schema: ns };
    } else {
      newContent[ct] = media;
    }
  }
  return changed ? { ...body, content: newContent } : body;
}

function walkSchema(schema: any, rewrite: (schema: any) => any): any {
  if (!schema || typeof schema !== "object" || schema.$ref) return schema;

  let next = schema;
  let changed = false;

  if (next.properties && typeof next.properties === "object") {
    const newProps: Record<string, any> = {};
    let pc = false;
    for (const [k, v] of Object.entries(next.properties)) {
      const nv = walkSchema(v, rewrite);
      newProps[k] = nv;
      if (nv !== v) pc = true;
    }
    if (pc) {
      next = { ...next, properties: newProps };
      changed = true;
    }
  }

  if (next.items && typeof next.items === "object") {
    const ni = walkSchema(next.items, rewrite);
    if (ni !== next.items) {
      next = { ...next, items: ni };
      changed = true;
    }
  }

  if (Array.isArray(next.prefixItems)) {
    const ni = next.prefixItems.map((it: any) => walkSchema(it, rewrite));
    if (ni.some((nv: any, i: number) => nv !== next.prefixItems[i])) {
      next = { ...next, prefixItems: ni };
      changed = true;
    }
  }

  if (next.additionalProperties && typeof next.additionalProperties === "object") {
    const nap = walkSchema(next.additionalProperties, rewrite);
    if (nap !== next.additionalProperties) {
      next = { ...next, additionalProperties: nap };
      changed = true;
    }
  }

  for (const k of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(next[k])) {
      const nbs = next[k].map((b: any) => walkSchema(b, rewrite));
      if (nbs.some((nv: any, i: number) => nv !== next[k][i])) {
        next = { ...next, [k]: nbs };
        changed = true;
      }
    }
  }

  const rewritten = rewrite(next);
  if (rewritten !== next) return rewritten;
  return changed ? next : schema;
}

function rewrite30Schema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (!schema.nullable) return schema;
  if (typeof schema.type !== "string") return schema;
  const t = schema.type;
  if (t === "string" || t === "number" || t === "integer" || t === "boolean") {
    const { nullable: _n, ...rest } = schema;
    return { ...rest, type: [t, "null"] };
  }
  return schema;
}

function mapValues<T, U>(obj: Record<string, T>, fn: (v: T) => U): Record<string, U> {
  const out: Record<string, U> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}
