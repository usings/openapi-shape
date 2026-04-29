import { indent, interfaceDecl, typeDecl, jsdoc, safeKey, safeIdentifier } from "./helpers";

export function schemaToType(schema: any): string {
  if (
    !schema ||
    (!schema.type &&
      !schema.$ref &&
      !schema.oneOf &&
      !schema.anyOf &&
      !schema.allOf &&
      !schema.enum &&
      !("const" in schema))
  ) {
    return "unknown";
  }

  if ("const" in schema) {
    return constToType(schema.const);
  }

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return "never";
    const literals = schema.enum.map((value: unknown) => constToType(value));
    return [...new Set<string>(literals)].join(" | ");
  }

  if (schema.$ref) {
    const parts = schema.$ref.split("/");
    return safeIdentifier(parts[parts.length - 1]);
  }

  if (schema.oneOf) {
    if (schema.oneOf.length === 0) return "never";
    return schema.oneOf.map((branch: any) => schemaToType(branch)).join(" | ");
  }

  if (schema.anyOf) {
    if (schema.anyOf.length === 0) return "never";
    return schema.anyOf.map((branch: any) => schemaToType(branch)).join(" | ");
  }

  if (schema.allOf) {
    return schema.allOf.map((branch: any) => schemaToType(branch)).join(" & ");
  }

  // Handle 3.1 type arrays like ["string", "null"]
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((typeName: string) => typeName !== "null");
    const tsTypes = nonNullTypes.map((typeName: string) => primitiveToTs(typeName));
    if (schema.type.includes("null")) {
      tsTypes.push("null");
    }
    return tsTypes.join(" | ");
  }

  let base = convertType(schema);

  // Handle 3.0 nullable
  if (schema.nullable) {
    base = `${base} | null`;
  }

  return base;
}

function primitiveToTs(type: string): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "unknown";
  }
}

function buildProps(schema: any): string {
  const required = new Set<string>(schema.required || []);
  const props = Object.entries(schema.properties).map(([key, value]: [string, any]) => {
    const opt = required.has(key) ? "" : "?";
    const propertyDoc = jsdoc(value);
    return `${propertyDoc}${safeKey(key)}${opt}: ${schemaToType(value)}`;
  });
  const indexSignature = buildIndexSignature(schema, required);
  if (indexSignature) props.push(indexSignature);
  return props.join("\n");
}

function buildIndexSignature(schema: any, required: Set<string>): string | null {
  if (!schema.properties || !isSchemaObject(schema.additionalProperties)) return null;

  const types = new Set<string>();
  const additionalType = schemaToType(schema.additionalProperties);
  if (additionalType === "unknown") {
    return "[key: string]: unknown";
  }
  types.add(asIndexType(additionalType));

  for (const [key, value] of Object.entries<any>(schema.properties)) {
    types.add(asIndexType(schemaToType(value)));
    if (!required.has(key)) types.add("undefined");
  }

  return `[key: string]: ${[...types].join(" | ")}`;
}

function asIndexType(type: string): string {
  return type.includes("\n") ? `(${type})` : type;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convertType(schema: any): string {
  if (schema.type === "string" && (schema.format === "binary" || schema.format === "byte")) {
    return "Blob";
  }

  if (schema.type === "array") {
    if (Array.isArray(schema.prefixItems)) {
      const tupleHead = schema.prefixItems.map((item: any) => schemaToType(item)).join(", ");
      if (schema.items === false || schema.items === undefined) {
        return `[${tupleHead}]`;
      }
      if (schema.items === true) {
        return `[${tupleHead}, ...unknown[]]`;
      }
      return `[${tupleHead}, ...${schemaToType(schema.items)}[]]`;
    }
    const itemType = schemaToType(schema.items);
    const needsParens = itemType.includes(" | ") || itemType.includes(" & ");
    return needsParens ? `(${itemType})[]` : `${itemType}[]`;
  }

  if (schema.type === "object") {
    if (!schema.properties && isSchemaObject(schema.additionalProperties)) {
      return `Record<string, ${schemaToType(schema.additionalProperties)}>`;
    }
    if (!schema.properties) {
      return "Record<string, unknown>";
    }
    return `{\n${indent(buildProps(schema))}\n}`;
  }

  return primitiveToTs(schema.type);
}

function constToType(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return "unknown";
}

export function generateSchemas(schemas: Record<string, any>): string {
  const types: string[] = [];
  const interfaces: string[] = [];

  const sanitizedToOriginal = new Map<string, string>();
  for (const name of Object.keys(schemas)) {
    const sanitized = safeIdentifier(name);
    const prior = sanitizedToOriginal.get(sanitized);
    if (prior !== undefined && prior !== name) {
      throw new Error(
        `Schema name collision after sanitization: "${prior}" and "${name}" both → "${sanitized}"`,
      );
    }
    sanitizedToOriginal.set(sanitized, name);
  }

  for (const [name, schema] of Object.entries(schemas)) {
    const safeName = safeIdentifier(name);
    const schemaDoc = jsdoc(schema);
    if (schema.type === "object" && schema.properties) {
      interfaces.push(schemaDoc + interfaceDecl(safeName, buildProps(schema)));
    } else {
      types.push(schemaDoc + typeDecl(safeName, schemaToType(schema)));
    }
  }

  return [...types, ...interfaces].join("\n\n");
}
