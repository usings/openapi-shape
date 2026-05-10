import type { OpenAPIDocument } from "../load/openapi";
import { safeIdentifier } from "../shared/naming";
import { escapePointerSegment } from "../shared/pointer";
import { BuildError } from "./errors";
import type { BuildOptions } from "./index";
import type { SchemaModel, FieldModel } from "./ir";
import { schemaToTypeNode, docBlock, objectIndex } from "./type-node";

export function buildSchemas(doc: OpenAPIDocument, options: BuildOptions): SchemaModel[] {
  const raw = doc.components?.schemas;
  if (!raw) return [];

  const sanitizedToOriginal = new Map<string, string>();
  for (const name of Object.keys(raw)) {
    const sanitized = safeIdentifier(name);
    const prior = sanitizedToOriginal.get(sanitized);
    if (prior !== undefined && prior !== name) {
      throw new BuildError(
        `Schema name collision after sanitization at /components/schemas: "${prior}" and "${name}" both → "${sanitized}"`,
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
      const index = objectIndex(schema, options);
      result.push({
        name,
        originalName,
        kind: "interface",
        fields,
        type: null,
        ...(index !== null && { index }),
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
