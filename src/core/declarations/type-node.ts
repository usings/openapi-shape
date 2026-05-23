import type { DocBlock, PrimitiveName } from "../contract/contract";
import { docBlock } from "../contract/doc";
import type { OpenAPISchema } from "../contract/openapi";
import { objectIndexSchemas } from "../contract/shapes";
import { safeIdentifier } from "../shared/naming";
import type { DeclarationOptions } from "./options";

/**
 * Renderer-friendly TypeScript type AST.
 *
 * This is the declaration layer's IR: schemas are converted into `TypeNode`
 * values first, then rendered to TypeScript source with formatting rules.
 */
export type TypeNode =
  /** TypeScript primitive or built-in name emitted verbatim. */
  | { kind: "primitive"; name: PrimitiveName }
  /** String, number, boolean, or null literal type. */
  | { kind: "literal"; value: string | number | boolean | null }
  /** Reference to a named schema. Renderers may prepend a namespace prefix. */
  | { kind: "ref"; name: string }
  /** Homogeneous array type. */
  | { kind: "array"; items: TypeNode }
  /** Tuple type, optionally with a rest item type. */
  | { kind: "tuple"; items: TypeNode[]; rest: TypeNode | null }
  /** Object literal type with declared fields and an optional string index signature. */
  | { kind: "object"; fields: TypeField[]; index: TypeNode | null }
  /** `Record<string, T>` object shape used when an object has no declared properties. */
  | { kind: "record"; values: TypeNode }
  /** TypeScript union. Empty source unions are normalized to `never` before this node. */
  | { kind: "union"; members: TypeNode[] }
  /** TypeScript intersection, primarily from OpenAPI `allOf`. */
  | { kind: "intersection"; members: TypeNode[] }
  /** Raw TypeScript supplied by options, such as custom `format` mappings. */
  | { kind: "raw"; text: string };

/** Object field in a rendered object or interface type. */
export interface TypeField {
  /** Original property name before TypeScript key escaping. */
  name: string;
  /** Whether the property is required. */
  required: boolean;
  /** Property value type. */
  type: TypeNode;
  /** Documentation copied from the source schema property. */
  docs?: DocBlock;
}

/**
 * Convert a supported OpenAPI schema into the declaration type AST.
 *
 * Unknown, empty, or unsupported schema shapes become `unknown`; empty enums and
 * empty unions become `never`; `allOf` becomes an intersection; `oneOf` and
 * `anyOf` become deduplicated unions.
 */
export function schemaToTypeNode(
  schema: OpenAPISchema | undefined,
  options: DeclarationOptions,
): TypeNode {
  if (!schema || isEmptySchema(schema)) return primitiveNode("unknown");

  if ("const" in schema) return constToTypeNode(schema.const);

  if (Array.isArray(schema.type)) return typeArrayToNode(schema, options);

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return primitiveNode("never");
    return uniqueUnion(schema.enum.map((v) => constToTypeNode(v)));
  }

  if (schema.$ref) {
    const last = schema.$ref.split("/").at(-1) ?? schema.$ref;
    return { kind: "ref", name: safeIdentifier(last) };
  }

  if (schema.oneOf) {
    if (schema.oneOf.length === 0) return primitiveNode("never");
    return uniqueUnion(schema.oneOf.map((b) => schemaToTypeNode(b, options)));
  }
  if (schema.anyOf) {
    if (schema.anyOf.length === 0) return primitiveNode("never");
    return uniqueUnion(schema.anyOf.map((b) => schemaToTypeNode(b, options)));
  }
  if (schema.allOf) {
    return {
      kind: "intersection",
      members: schema.allOf.map((b) => schemaToTypeNode(b, options)),
    };
  }

  return convertSingleType(schema, options);
}

/** Create a primitive TypeNode. */
export function primitiveNode(name: PrimitiveName): TypeNode {
  return { kind: "primitive", name };
}

function isEmptySchema(s: OpenAPISchema): boolean {
  return (
    s.type === undefined &&
    !s.$ref &&
    !s.oneOf &&
    !s.anyOf &&
    !s.allOf &&
    !s.enum &&
    !("const" in s)
  );
}

function typeArrayToNode(schema: OpenAPISchema, options: DeclarationOptions): TypeNode {
  const types = schema.type as string[];
  const nonNull = types.filter((t) => t !== "null");
  const includesNull = types.includes("null");

  if (
    schema.format !== undefined &&
    options.formats &&
    Object.hasOwn(options.formats, schema.format) &&
    nonNull.length === 1 &&
    isFormatMappablePrimitive(nonNull[0])
  ) {
    const mapped: TypeNode = { kind: "raw", text: options.formats[schema.format] };
    return includesNull ? { kind: "union", members: [mapped, primitiveNode("null")] } : mapped;
  }

  const inner: TypeNode[] = nonNull.map((t) => convertSingleType({ ...schema, type: t }, options));
  if (includesNull) inner.push(primitiveNode("null"));
  if (inner.length === 1) return inner[0];
  return { kind: "union", members: inner };
}

function convertSingleType(schema: OpenAPISchema, options: DeclarationOptions): TypeNode {
  const t = typeof schema.type === "string" ? schema.type : undefined;

  if (
    schema.format !== undefined &&
    options.formats &&
    Object.hasOwn(options.formats, schema.format) &&
    (t === undefined || isFormatMappablePrimitive(t))
  ) {
    return { kind: "raw", text: options.formats[schema.format] };
  }

  if (
    (t === "string" || t === undefined) &&
    (schema.format === "binary" || schema.format === "byte")
  ) {
    return primitiveNode("Blob");
  }

  if (t === "array") return arrayToNode(schema, options);
  if (t === "object") return objectToNode(schema, options);
  if (t === undefined) return primitiveNode("unknown");
  return primitiveStringToNode(t);
}

function arrayToNode(schema: OpenAPISchema, options: DeclarationOptions): TypeNode {
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((it) => schemaToTypeNode(it, options));
    let rest: TypeNode | null = null;
    if (schema.items === true) rest = primitiveNode("unknown");
    else if (schema.items && typeof schema.items === "object")
      rest = schemaToTypeNode(schema.items, options);
    return { kind: "tuple", items, rest };
  }
  const items =
    typeof schema.items === "object" && schema.items !== null
      ? schemaToTypeNode(schema.items, options)
      : primitiveNode("unknown");
  return { kind: "array", items };
}

function objectToNode(schema: OpenAPISchema, options: DeclarationOptions): TypeNode {
  const index = objectIndexNode(schema, options);
  if (!schema.properties) {
    return { kind: "record", values: index ?? primitiveNode("unknown") };
  }
  const required = new Set<string>(schema.required ?? []);
  const fields: TypeField[] = Object.entries(schema.properties).map(([name, value]) => ({
    name,
    required: required.has(name),
    type: schemaToTypeNode(value, options),
    docs: docBlock(value),
  }));
  return { kind: "object", fields, index };
}

/**
 * Convert object index-signature sources into a TypeNode.
 *
 * `patternProperties` and schema-valued `additionalProperties` are collected by
 * `objectIndexSchemas`; multiple value schemas become a union.
 */
export function objectIndexNode(
  schema: OpenAPISchema,
  options: DeclarationOptions,
): TypeNode | null {
  const values = objectIndexSchemas(schema).map((s) => schemaToTypeNode(s, options));
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  return { kind: "union", members: values };
}

function isFormatMappablePrimitive(t: string): boolean {
  return t === "string" || t === "number" || t === "integer";
}

function primitiveStringToNode(t: string): TypeNode {
  switch (t) {
    case "string":
      return primitiveNode("string");
    case "number":
    case "integer":
      return primitiveNode("number");
    case "boolean":
      return primitiveNode("boolean");
    case "null":
      return primitiveNode("null");
    default:
      return primitiveNode("unknown");
  }
}

function constToTypeNode(value: unknown): TypeNode {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return { kind: "literal", value };
  }
  return primitiveNode("unknown");
}

function uniqueUnion(members: TypeNode[]): TypeNode {
  const seen = new Set<string>();
  const dedup: TypeNode[] = [];
  for (const m of members) {
    const key = JSON.stringify(m);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(m);
  }
  if (dedup.length === 1) return dedup[0];
  return { kind: "union", members: dedup };
}
