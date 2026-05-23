import type { DocBlock } from "./contract";
import type { OpenAPISchema } from "./openapi";

export function docBlock(s: OpenAPISchema | undefined): DocBlock | undefined {
  if (!s) return undefined;
  const out: DocBlock = {};
  if (s.summary) out.summary = s.summary;
  if (s.description) out.description = s.description;
  if (s.deprecated) out.deprecated = true;
  return Object.keys(out).length === 0 ? undefined : out;
}
