import { isObjectAdditional } from "../shared/object";
import type { ContractShape, PrimitiveName } from "./contract";
import type { OpenAPISchema } from "./openapi";

export function schemaShape(schema: OpenAPISchema | undefined): ContractShape {
  return { kind: "schema", schema };
}

export function primitiveShape(name: PrimitiveName): ContractShape {
  return { kind: "primitive", name };
}

export function objectIndexShape(schema: OpenAPISchema): ContractShape | null {
  const values = objectIndexSchemas(schema);
  if (values.length === 0) return null;
  if (values.length === 1) return schemaShape(values[0]);
  return schemaShape({ anyOf: values });
}

export function objectIndexSchemas(schema: OpenAPISchema): OpenAPISchema[] {
  const values: OpenAPISchema[] = [];
  if (schema.patternProperties) values.push(...Object.values(schema.patternProperties));
  if (isObjectAdditional<OpenAPISchema>(schema.additionalProperties)) {
    values.push(schema.additionalProperties);
  }
  return values;
}
