import type { OpenAPISchema } from "../load/openapi";
import type { TypeNode, PrimitiveName, FieldModel, DocBlock } from "./ir";
import { safeIdentifier } from "../shared/naming";
import { isObject } from "../shared/object";
import type { BuildOptions } from "./index";

export function schemaToTypeNode(
  schema: OpenAPISchema | undefined,
  options: BuildOptions,
): TypeNode {
  if (!schema || isEmptySchema(schema)) return primitive("unknown");

  if ("const" in schema) return constToTypeNode(schema.const);

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return primitive("never");
    return uniqueUnion(schema.enum.map((v) => constToTypeNode(v)));
  }

  if (schema.$ref) {
    const parts = schema.$ref.split("/");
    return { kind: "ref", name: safeIdentifier(parts[parts.length - 1]) };
  }

  if (schema.oneOf) {
    if (schema.oneOf.length === 0) return primitive("never");
    return uniqueUnion(schema.oneOf.map((b) => schemaToTypeNode(b, options)));
  }
  if (schema.anyOf) {
    if (schema.anyOf.length === 0) return primitive("never");
    return uniqueUnion(schema.anyOf.map((b) => schemaToTypeNode(b, options)));
  }
  if (schema.allOf) {
    return {
      kind: "intersection",
      members: schema.allOf.map((b) => schemaToTypeNode(b, options)),
    };
  }

  if (Array.isArray(schema.type)) return typeArrayToNode(schema, options);

  return convertSingleType(schema, options);
}

export function primitive(name: PrimitiveName): TypeNode {
  return { kind: "primitive", name };
}

export function docBlock(s: OpenAPISchema | undefined): DocBlock | undefined {
  if (!s) return undefined;
  const out: DocBlock = {};
  if (s.summary) out.summary = s.summary;
  if (s.description) out.description = s.description;
  if (s.deprecated) out.deprecated = true;
  return Object.keys(out).length === 0 ? undefined : out;
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

function typeArrayToNode(schema: OpenAPISchema, options: BuildOptions): TypeNode {
  const types = schema.type as string[];
  const nonNull = types.filter((t) => t !== "null");
  const includesNull = types.includes("null");

  if (
    schema.format !== undefined &&
    options.formats &&
    Object.prototype.hasOwnProperty.call(options.formats, schema.format) &&
    nonNull.length === 1 &&
    isFormatMappablePrimitive(nonNull[0])
  ) {
    const mapped: TypeNode = { kind: "raw", text: options.formats[schema.format] };
    return includesNull ? { kind: "union", members: [mapped, primitive("null")] } : mapped;
  }

  const inner: TypeNode[] = nonNull.map((t) => primitiveStringToNode(t));
  if (includesNull) inner.push(primitive("null"));
  if (inner.length === 1) return inner[0];
  return { kind: "union", members: inner };
}

function convertSingleType(schema: OpenAPISchema, options: BuildOptions): TypeNode {
  const t = typeof schema.type === "string" ? schema.type : undefined;

  if (
    schema.format !== undefined &&
    options.formats &&
    Object.prototype.hasOwnProperty.call(options.formats, schema.format) &&
    (t === undefined || isFormatMappablePrimitive(t))
  ) {
    return { kind: "raw", text: options.formats[schema.format] };
  }

  if (
    (t === "string" || t === undefined) &&
    (schema.format === "binary" || schema.format === "byte")
  ) {
    return primitive("Blob");
  }

  if (t === "array") return arrayToNode(schema, options);
  if (t === "object") return objectToNode(schema, options);
  if (t === undefined) return primitive("unknown");
  return primitiveStringToNode(t);
}

function arrayToNode(schema: OpenAPISchema, options: BuildOptions): TypeNode {
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((it) => schemaToTypeNode(it, options));
    let rest: TypeNode | null = null;
    if (schema.items === true) rest = primitive("unknown");
    else if (schema.items && typeof schema.items === "object")
      rest = schemaToTypeNode(schema.items, options);
    return { kind: "tuple", items, rest };
  }
  const items =
    typeof schema.items === "object" && schema.items !== null
      ? schemaToTypeNode(schema.items, options)
      : primitive("unknown");
  return { kind: "array", items };
}

function objectToNode(schema: OpenAPISchema, options: BuildOptions): TypeNode {
  if (!schema.properties && isObjectAdditional(schema.additionalProperties)) {
    return { kind: "record", values: schemaToTypeNode(schema.additionalProperties, options) };
  }
  if (!schema.properties) {
    return { kind: "record", values: primitive("unknown") };
  }
  const required = new Set<string>(schema.required ?? []);
  const fields: FieldModel[] = Object.entries(schema.properties).map(([name, value]) => ({
    name,
    required: required.has(name),
    type: schemaToTypeNode(value, options),
    docs: docBlock(value),
  }));
  let index: TypeNode | null = null;
  if (isObjectAdditional(schema.additionalProperties)) {
    index = schemaToTypeNode(schema.additionalProperties, options);
  }
  return { kind: "object", fields, index };
}

function isObjectAdditional(v: unknown): v is OpenAPISchema {
  return isObject(v) && !Array.isArray(v);
}

function isFormatMappablePrimitive(t: string): boolean {
  return t === "string" || t === "number" || t === "integer";
}

function primitiveStringToNode(t: string): TypeNode {
  switch (t) {
    case "string":
      return primitive("string");
    case "number":
    case "integer":
      return primitive("number");
    case "boolean":
      return primitive("boolean");
    case "null":
      return primitive("null");
    default:
      return primitive("unknown");
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
  return primitive("unknown");
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
