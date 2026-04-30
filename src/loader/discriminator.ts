// src/loader/discriminator.ts
import type { OpenAPIDocument, OpenAPISchema } from "../types/openapi";
import { BuildError } from "../errors";

type Injection = { value: string; sourceLocation: string };
type SchemaInjections = Map<string, Map<string, Injection>>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function injectDiscriminators(doc: OpenAPIDocument): OpenAPIDocument {
  const injections: SchemaInjections = new Map();
  walkDiscriminators(doc, injections, "");
  return applyInjections(doc, injections);
}

function walkDiscriminators(node: unknown, injections: SchemaInjections, location: string): void {
  if (!isObject(node)) return;

  const disc = node.discriminator;
  if (isObject(disc) && typeof disc.propertyName === "string") {
    if (Array.isArray(node.oneOf)) {
      processDiscriminator(disc, node.oneOf, "oneOf", injections, location);
    } else if (Array.isArray(node.anyOf)) {
      processDiscriminator(disc, node.anyOf, "anyOf", injections, location);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    walkDiscriminators(value, injections, `${location}/${key}`);
  }
}

function processDiscriminator(
  disc: Record<string, unknown>,
  branches: unknown[],
  containerKey: "oneOf" | "anyOf",
  injections: SchemaInjections,
  location: string,
): void {
  const propertyName = disc.propertyName as string;
  const mapping = isObject(disc.mapping) ? (disc.mapping as Record<string, string>) : {};

  branches.forEach((branch, index) => {
    const branchLocation = `${location}/${containerKey}[${index}]`;
    if (!isObject(branch) || typeof branch.$ref !== "string") {
      throw new BuildError(`discriminator branch must be $ref; got inline schema`, branchLocation);
    }
    const ref = branch.$ref;
    if (!ref.startsWith("#/components/schemas/")) {
      throw new BuildError(
        `discriminator branch $ref must point to components.schemas; got ${ref}`,
        branchLocation,
      );
    }
    const schemaName = ref.slice("#/components/schemas/".length);
    const value = findValueForBranch(ref, schemaName, mapping);
    addInjection(injections, schemaName, propertyName, value, branchLocation);
  });
}

function findValueForBranch(
  ref: string,
  schemaName: string,
  mapping: Record<string, string>,
): string {
  for (const [v, target] of Object.entries(mapping)) {
    if (target === ref || target === schemaName) return v;
  }
  return schemaName;
}

function addInjection(
  injections: SchemaInjections,
  schemaName: string,
  propertyName: string,
  value: string,
  location: string,
): void {
  let perSchema = injections.get(schemaName);
  if (!perSchema) {
    perSchema = new Map();
    injections.set(schemaName, perSchema);
  }
  const existing = perSchema.get(propertyName);
  if (existing && existing.value !== value) {
    throw new BuildError(
      `Discriminator value conflict for "${schemaName}.${propertyName}": "${existing.value}" (at ${existing.sourceLocation}) vs "${value}" (at ${location})`,
      location,
    );
  }
  perSchema.set(propertyName, { value, sourceLocation: location });
}

function applyInjections(doc: OpenAPIDocument, injections: SchemaInjections): OpenAPIDocument {
  if (injections.size === 0) return doc;
  const schemas = doc.components?.schemas;
  if (!schemas) return doc;

  for (const name of injections.keys()) {
    if (!(name in schemas)) {
      throw new BuildError(
        `Discriminator branch references unknown schema "${name}"`,
        `/components/schemas/${name}`,
      );
    }
  }

  const newSchemas: Record<string, OpenAPISchema> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const perSchema = injections.get(name);
    newSchemas[name] = perSchema ? injectInto(schema, perSchema, name) : schema;
  }
  return { ...doc, components: { ...doc.components, schemas: newSchemas } };
}

function injectInto(
  schema: OpenAPISchema,
  perSchema: Map<string, Injection>,
  schemaName: string,
): OpenAPISchema {
  if (schema.allOf) return injectIntoAllOf(schema, perSchema, schemaName);
  if (schema.type !== undefined && schema.type !== "object") {
    throw new BuildError(
      `Cannot inject discriminator into "${schemaName}": schema is not an object type (got "${String(schema.type)}")`,
      `/components/schemas/${schemaName}`,
    );
  }

  const properties: Record<string, OpenAPISchema> = { ...schema.properties };
  const required = new Set<string>(schema.required ?? []);
  for (const [propertyName, { value }] of perSchema) {
    const existing = properties[propertyName];
    if (existing) validateExistingProperty(schemaName, propertyName, existing, value);
    properties[propertyName] = { const: value };
    required.add(propertyName);
  }
  return { ...schema, properties, required: [...required] };
}

function injectIntoAllOf(
  schema: OpenAPISchema,
  perSchema: Map<string, Injection>,
  schemaName: string,
): OpenAPISchema {
  const allOf = (schema.allOf ?? []).map((m) => ({ ...m }));
  const targetIndex = allOf.findIndex(canReceiveDiscriminator);
  if (targetIndex === -1) {
    allOf.push(createDiscriminatorMember(perSchema));
  } else {
    allOf[targetIndex] = injectInto(allOf[targetIndex], perSchema, schemaName);
  }
  return { ...schema, allOf };
}

function canReceiveDiscriminator(member: OpenAPISchema | undefined): boolean {
  if (!member || typeof member !== "object" || member.$ref || member.allOf) return false;
  return member.type === undefined || member.type === "object";
}

function createDiscriminatorMember(perSchema: Map<string, Injection>): OpenAPISchema {
  const properties: Record<string, OpenAPISchema> = {};
  const required: string[] = [];
  for (const [propertyName, { value }] of perSchema) {
    properties[propertyName] = { const: value };
    required.push(propertyName);
  }
  return { type: "object", properties, required };
}

function validateExistingProperty(
  schemaName: string,
  propertyName: string,
  existing: OpenAPISchema,
  value: string,
): void {
  if ("const" in existing) {
    if (existing.const !== value) {
      throw new BuildError(
        `Discriminator conflict in schema "${schemaName}": "${propertyName}" is declared as const "${String(existing.const)}", but discriminator says "${value}"`,
        `/components/schemas/${schemaName}/properties/${propertyName}`,
      );
    }
    return;
  }
  if (Array.isArray(existing.enum)) {
    if (!existing.enum.includes(value)) {
      const printed = existing.enum.map((e) => JSON.stringify(e)).join(", ");
      throw new BuildError(
        `Discriminator conflict in schema "${schemaName}": "${propertyName}" is declared as enum [${printed}], but discriminator says "${value}"`,
        `/components/schemas/${schemaName}/properties/${propertyName}`,
      );
    }
    return;
  }
  if (existing.type !== undefined && existing.type !== "string") {
    throw new BuildError(
      `Discriminator conflict in schema "${schemaName}": "${propertyName}" is declared as type "${String(existing.type)}", but discriminator requires string literal "${value}"`,
      `/components/schemas/${schemaName}/properties/${propertyName}`,
    );
  }
}
