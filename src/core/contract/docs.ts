import type { Node } from "../openapi/documents"
import { isRecord } from "../shared/object"
import type { Docs } from "./model"

/**
 * Documentation for a schema: title, description, deprecation, and the
 * constraints TypeScript cannot express, as JSDoc tags.
 */
export function schemaDocs(node: Node): Docs | undefined {
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
  return makeDocs({
    title: schema.title,
    description: schema.description,
    deprecated: schema.deprecated,
    externalDocs: schema.externalDocs,
    tags,
  })
}

/** Documentation for a non-schema object (operation, parameter, response, …). */
export function objectDocs(value: unknown, tags: Array<[string, string]> = []): Docs | undefined {
  if (!isRecord(value)) return makeDocs({ tags })
  return makeDocs({
    summary: value.summary,
    description: value.description,
    deprecated: value.deprecated,
    externalDocs: value.externalDocs,
    tags,
  })
}

function makeDocs(input: {
  title?: unknown
  summary?: unknown
  description?: unknown
  deprecated?: unknown
  externalDocs?: unknown
  tags: Array<[string, string]>
}): Docs | undefined {
  const docs: Docs = {}
  const title = text(input.title)
  const summary = text(input.summary)
  const description = text(input.description)
  if (title !== undefined) docs.title = title
  if (summary !== undefined) docs.summary = summary
  if (description !== undefined) docs.description = description
  if (input.deprecated === true) docs.deprecated = true
  const tags = [...input.tags]
  if (isRecord(input.externalDocs) && typeof input.externalDocs.url === "string") {
    const label = text(input.externalDocs.description)
    tags.push([
      "see",
      label === undefined ? input.externalDocs.url : `${input.externalDocs.url} ${label}`,
    ])
  }
  if (tags.length > 0) docs.tags = tags
  return Object.keys(docs).length === 0 ? undefined : docs
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** Combine docs; `primary` text wins, deprecation and tags accumulate. */
export function mergeDocs(
  primary: Docs | undefined,
  secondary: Docs | undefined,
): Docs | undefined {
  if (primary === undefined) return secondary
  if (secondary === undefined) return primary
  const out: Docs = { ...secondary, ...primary }
  if (primary.deprecated === true || secondary.deprecated === true) out.deprecated = true
  const tags = [...(primary.tags ?? []), ...(secondary.tags ?? [])]
  if (tags.length > 0) out.tags = tags
  return out
}
