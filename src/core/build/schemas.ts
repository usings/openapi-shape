import type { OpenAPIDocument } from "../load/openapi";
import type { SchemaModel, FieldModel } from "./ir";
import { BuildError } from "../shared/errors";
import { safeIdentifier } from "../shared/naming";
import { escapePointerSegment } from "../shared/pointer";
import { schemaToTypeNode, docBlock } from "./type-node";
import type { BuildOptions } from "./index";

export function buildSchemas(doc: OpenAPIDocument, options: BuildOptions): SchemaModel[] {
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
        source: { location: `/components/schemas/${escapePointerSegment(originalName)}` },
      });
    } else {
      result.push({
        name,
        originalName,
        kind: "alias",
        fields: null,
        type: schemaToTypeNode(schema, options),
        docs: docBlock(schema),
        source: { location: `/components/schemas/${escapePointerSegment(originalName)}` },
      });
    }
  }
  return result;
}
