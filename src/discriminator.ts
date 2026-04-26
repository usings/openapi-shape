type Injection = { value: string; sourceLocation: string };
type SchemaInjections = Map<string, Map<string, Injection>>;

export function injectDiscriminators(openapi: any): any {
  const injections: SchemaInjections = new Map();
  walkDiscriminators(openapi, injections, "");
  return applyInjections(openapi, injections);
}

function walkDiscriminators(node: any, injections: SchemaInjections, location: string): void {
  if (node == null || typeof node !== "object") return;

  if (node.discriminator?.propertyName) {
    if (Array.isArray(node.oneOf)) {
      processDiscriminator(node, node.oneOf, "oneOf", injections, location);
    } else if (Array.isArray(node.anyOf)) {
      processDiscriminator(node, node.anyOf, "anyOf", injections, location);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    walkDiscriminators(value, injections, `${location}/${key}`);
  }
}

function processDiscriminator(
  node: any,
  branches: any[],
  containerKey: "oneOf" | "anyOf",
  injections: SchemaInjections,
  location: string,
): void {
  const propertyName: string = node.discriminator.propertyName;
  const mapping: Record<string, string> = node.discriminator.mapping ?? {};

  branches.forEach((branch, index) => {
    const branchLocation = `${location}/${containerKey}[${index}]`;
    if (!branch?.$ref) {
      throw new Error(`discriminator branch must be $ref at ${branchLocation}; got inline schema`);
    }
    if (!branch.$ref.startsWith("#/components/schemas/")) {
      throw new Error(
        `discriminator branch $ref must point to components.schemas at ${branchLocation}; got ${branch.$ref}`,
      );
    }
    const schemaName = branch.$ref.slice("#/components/schemas/".length);
    const value = findValueForBranch(branch.$ref, schemaName, mapping);
    addInjection(injections, schemaName, propertyName, value, branchLocation);
  });
}

function findValueForBranch(
  ref: string,
  schemaName: string,
  mapping: Record<string, string>,
): string {
  for (const [value, target] of Object.entries(mapping)) {
    if (target === ref || target === schemaName) return value;
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
  if (!perSchema) injections.set(schemaName, (perSchema = new Map()));

  const existing = perSchema.get(propertyName);
  if (existing && existing.value !== value) {
    throw new Error(
      `Discriminator value conflict for "${schemaName}.${propertyName}": ` +
        `"${existing.value}" (at ${existing.sourceLocation}) vs "${value}" (at ${location})`,
    );
  }
  perSchema.set(propertyName, { value, sourceLocation: location });
}

function applyInjections(openapi: any, injections: SchemaInjections): any {
  if (injections.size === 0) return openapi;
  const schemas = openapi?.components?.schemas;
  if (!schemas) return openapi;

  for (const schemaName of injections.keys()) {
    if (!(schemaName in schemas)) {
      throw new Error(`Discriminator branch references unknown schema "${schemaName}"`);
    }
  }

  const newSchemas: Record<string, any> = {};
  for (const [name, schema] of Object.entries<any>(schemas)) {
    const perSchema = injections.get(name);
    newSchemas[name] = perSchema ? injectInto(schema, perSchema, name) : schema;
  }
  return { ...openapi, components: { ...openapi.components, schemas: newSchemas } };
}

function injectInto(schema: any, perSchema: Map<string, Injection>, schemaName: string): any {
  if (schema.allOf) {
    return injectIntoAllOf(schema, perSchema, schemaName);
  }
  if (schema.type && schema.type !== "object") {
    throw new Error(
      `Cannot inject discriminator into "${schemaName}": schema is not an object type (got "${schema.type}")`,
    );
  }

  const properties = { ...schema.properties };
  const required = new Set<string>(schema.required ?? []);
  for (const [propertyName, { value }] of perSchema) {
    const existing = properties[propertyName];
    if (existing) validateExistingProperty(schemaName, propertyName, existing, value);
    properties[propertyName] = { const: value };
    required.add(propertyName);
  }
  return { ...schema, properties, required: [...required] };
}

function injectIntoAllOf(schema: any, perSchema: Map<string, Injection>, schemaName: string): any {
  if (!Array.isArray(schema.allOf)) {
    return schema;
  }

  const allOf = schema.allOf.map((member: any) => ({ ...member }));
  const targetIndex = allOf.findIndex(canReceiveDiscriminator);
  const discriminatorMember =
    targetIndex === -1
      ? createDiscriminatorMember(perSchema)
      : injectInto(allOf[targetIndex], perSchema, schemaName);

  if (targetIndex === -1) {
    allOf.push(discriminatorMember);
  } else {
    allOf[targetIndex] = discriminatorMember;
  }

  return { ...schema, allOf };
}

function canReceiveDiscriminator(member: any): boolean {
  if (!member || typeof member !== "object" || member.$ref || member.allOf) return false;
  return !member.type || member.type === "object";
}

function createDiscriminatorMember(perSchema: Map<string, Injection>): any {
  const properties: Record<string, any> = {};
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
  existing: any,
  value: string,
): void {
  if ("const" in existing) {
    if (existing.const !== value) {
      throw new Error(
        `Discriminator conflict in schema "${schemaName}": ` +
          `"${propertyName}" is declared as const "${existing.const}", but discriminator says "${value}"`,
      );
    }
    return;
  }
  if (Array.isArray(existing.enum)) {
    if (!existing.enum.includes(value)) {
      const printed = existing.enum
        .map((enumValue: unknown) => JSON.stringify(enumValue))
        .join(", ");
      throw new Error(
        `Discriminator conflict in schema "${schemaName}": ` +
          `"${propertyName}" is declared as enum [${printed}], but discriminator says "${value}"`,
      );
    }
    return;
  }
  if (existing.type && existing.type !== "string") {
    throw new Error(
      `Discriminator conflict in schema "${schemaName}": ` +
        `"${propertyName}" is declared as type "${existing.type}", but discriminator requires string literal "${value}"`,
    );
  }
}
