import type { DocBlock, PrimitiveName } from "../contract/contract";
import { docBlock } from "../contract/doc";
import type { OpenAPISchema } from "../contract/openapi";
import { objectIndexSchemas } from "../contract/shapes";
import { safeIdentifier } from "../shared/naming";
import type { DeclarationOptions } from "./options";

export type TypeNode =
  | { kind: "primitive"; name: PrimitiveName }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "ref"; name: string }
  | { kind: "array"; items: TypeNode }
  | { kind: "tuple"; items: TypeNode[]; rest: TypeNode | null }
  | { kind: "object"; fields: TypeField[]; index: TypeNode | null }
  | { kind: "record"; values: TypeNode }
  | { kind: "union"; members: TypeNode[] }
  | { kind: "intersection"; members: TypeNode[] }
  | { kind: "raw"; text: string };

export interface TypeField {
  name: string;
  required: boolean;
  type: TypeNode;
  docs?: DocBlock;
}

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
