import type { DocumentNode } from "../load/documents"
import type { Annotations } from "../model/types"
import { isRecord } from "../shared/object"

/**
 * Documentation for a schema: title, description, deprecation, and the constraints TypeScript
 * cannot express, as JSDoc tags.
 */
export function schemaAnnotations(node: DocumentNode): Annotations | undefined {
  const schema = node.value
  if (!isRecord(schema)) return undefined

  const tags: Array<[string, string]> = []
  const tag = (name: string, value: unknown): void => {
    if (value === undefined) return
    tags.push([name, typeof value === "string" ? value : JSON.stringify(value)])
  }
  if (typeof schema.format === "string") tag("format", schema.format)
  if ("default" in schema) tag("default", JSON.stringify(schema.default))
  for (const bound of ["minimum", "maximum"] as const) {
    const exclusiveKey = bound === "minimum" ? "exclusiveMinimum" : "exclusiveMaximum"
    const value = schema[bound]
    const exclusive = schema[exclusiveKey]
    if (typeof exclusive === "number") tag(exclusiveKey, exclusive)
    if (typeof value === "number") tag(exclusive === true ? exclusiveKey : bound, value)
  }
  for (const key of [
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "contentMediaType",
    "contentEncoding",
  ]) {
    const value = schema[key]
    if (typeof value === "number" || typeof value === "string") tag(key, value)
  }
  for (const flag of ["uniqueItems", "readOnly", "writeOnly"]) {
    if (schema[flag] === true) tags.push([flag, ""])
  }
  return makeAnnotations({
    title: schema.title,
    description: schema.description,
    deprecated: schema.deprecated,
    externalDocs: schema.externalDocs,
    tags,
  })
}

/** Documentation for a non-schema object (operation, parameter, response, …). */
export function objectAnnotations(
  value: unknown,
  tags: Array<[string, string]> = [],
): Annotations | undefined {
  if (!isRecord(value)) return makeAnnotations({ tags })
  return makeAnnotations({
    summary: value.summary,
    description: value.description,
    deprecated: value.deprecated,
    externalDocs: value.externalDocs,
    tags,
  })
}

function makeAnnotations(input: {
  title?: unknown
  summary?: unknown
  description?: unknown
  deprecated?: unknown
  externalDocs?: unknown
  tags: Array<[string, string]>
}): Annotations | undefined {
  const annotations: Annotations = {}
  const title = text(input.title)
  const summary = text(input.summary)
  const description = text(input.description)
  if (title !== undefined) annotations.title = title
  if (summary !== undefined) annotations.summary = summary
  if (description !== undefined) annotations.description = description
  if (input.deprecated === true) annotations.deprecated = true
  const tags = [...input.tags]
  if (isRecord(input.externalDocs) && typeof input.externalDocs.url === "string") {
    const label = text(input.externalDocs.description)
    tags.push([
      "see",
      label === undefined ? input.externalDocs.url : `${input.externalDocs.url} ${label}`,
    ])
  }
  if (tags.length > 0) annotations.tags = tags
  return Object.keys(annotations).length === 0 ? undefined : annotations
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** Combine annotations; `primary` text wins, deprecation and tags accumulate. */
export function mergeAnnotations(
  primary: Annotations | undefined,
  secondary: Annotations | undefined,
): Annotations | undefined {
  if (primary === undefined) return secondary
  if (secondary === undefined) return primary
  const out: Annotations = { ...secondary, ...primary }
  if (primary.deprecated === true || secondary.deprecated === true) out.deprecated = true
  const tags = [...(primary.tags ?? []), ...(secondary.tags ?? [])]
  if (tags.length > 0) out.tags = tags
  return out
}
