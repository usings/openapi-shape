import type { DocumentNode } from "../load/documents"
import { componentNameOf, identity } from "../load/nodes"
import { intersect, literal, union } from "../model/algebra"
import type { Type } from "../model/types"
import { isRecord } from "../shared/object"
import { referencesOf } from "./references"
import type { SchemaBuilder } from "./schemas"

/**
 * Discriminator Objects are hints that "MUST NOT change the validation outcome". They narrow types
 * only where a branch leaves the property open: a branch that already declares string literals for
 * it keeps them, and an explicit mapping that contradicts those literals is reported instead.
 * Narrowings are recorded while building and applied by `applyNarrowing`.
 */
export function narrowDiscriminated(
  schemas: SchemaBuilder,
  node: DocumentNode,
  keyword: "oneOf" | "anyOf",
  types: Type[],
): Type[] {
  const schema = node.value as Record<string, unknown>
  const discriminator = readDiscriminator(schemas, node)
  // With both present, the discriminator describes the oneOf.
  if (discriminator === undefined || (keyword === "anyOf" && Array.isArray(schema.oneOf))) {
    return types
  }
  return types.map((type, i) => {
    const branch = schemas.context.documents.child(node, keyword, i)
    if (referencesOf(branch.value).length === 0) return type
    const chain = refChain(schemas, branch)
    if (chain.length === 0) return type
    const member = {
      ids: new Set(chain.map((n) => identity(n))),
      name: chain.map((n) => componentNameOf(n)).find((n) => n !== undefined),
    }
    return narrow(schemas, branch, type, discriminator, [member])
  })
}

/**
 * Narrow a named component by the discriminators of the schemas it extends through `allOf`: such a
 * component is one of the parent's alternatives, and so is every component extending it in turn
 * (OpenAPI 3.0.4 recommends searching the components for them).
 */
export function parentDiscriminators(
  schemas: SchemaBuilder,
  node: DocumentNode,
  componentName: string,
  type: Type,
  selfIds: string[],
): Type {
  let out = type
  const applied = new Set<string>()
  for (const parent of allOfParents(schemas, node, new Set(selfIds))) {
    const discriminator = readDiscriminator(schemas, parent)
    if (discriminator === undefined || applied.has(discriminator.property)) continue
    applied.add(discriminator.property)
    const family = [
      { ids: new Set(selfIds), name: componentName },
      ...descendants(schemas, selfIds),
    ]
    out = narrow(schemas, node, out, discriminator, family)
  }
  return out
}

interface Discriminator {
  property: string
  mapping: Array<{ value: string; ids: Set<string> }>
  defaultIds?: Set<string>
}

function readDiscriminator(schemas: SchemaBuilder, node: DocumentNode): Discriminator | undefined {
  const schema = node.value
  if (!isRecord(schema)) return undefined
  const raw = schema.discriminator
  if (!isRecord(raw) || typeof raw.propertyName !== "string") return undefined
  const at = schemas.context.documents.child(node, "discriminator")
  const mapping: Discriminator["mapping"] = []
  if (isRecord(raw.mapping)) {
    for (const [value, target] of Object.entries(raw.mapping)) {
      if (typeof target !== "string") continue
      const ids = mappingTarget(schemas, at, target)
      if (ids) mapping.push({ value, ids })
      else {
        schemas.context.warn(
          "discriminator-mismatch",
          `Discriminator mapping "${value}" points to "${target}", which does not resolve to a schema`,
          at,
          "mapping",
        )
      }
    }
  }
  const out: Discriminator = { property: raw.propertyName, mapping }
  if (typeof raw.defaultMapping === "string" && node.document.version === "3.2") {
    out.defaultIds = mappingTarget(schemas, at, raw.defaultMapping)
  }
  return out
}

/**
 * Resolve a mapping value: a URI reference when it has a scheme, `/`, or `#`, else a component
 * name.
 */
function mappingTarget(
  schemas: SchemaBuilder,
  at: DocumentNode,
  target: string,
): Set<string> | undefined {
  let node: DocumentNode | undefined
  if (!/^[a-z][a-z\d+.-]*:|[/#]/i.test(target)) {
    const annotations = schemas.context.documents
    for (const document of [at.document, annotations.entry]) {
      const candidate = annotations.child(
        annotations.root(document),
        "components",
        "schemas",
        target,
      )
      if (candidate.value !== undefined) {
        node = candidate
        break
      }
    }
  } else {
    const resolution = schemas.context.documents.resolveSchema(target, at)
    if (resolution.kind === "found") node = resolution.node
    else if (resolution.kind === "pending") return new Set()
  }
  if (node === undefined) return undefined
  return new Set([identity(node), ...refChain(schemas, node).map((n) => identity(n))])
}

/** A schema a discriminator can select: its identities and its component name. */
interface Member {
  ids: Set<string>
  name?: string
}

function narrow(
  schemas: SchemaBuilder,
  at: DocumentNode,
  type: Type,
  discriminator: Discriminator,
  members: Member[],
): Type {
  const found = new Set<string>()
  let explicit = false
  for (const member of members) {
    // The default mapping target accepts values no other schema claims.
    if (discriminator.defaultIds && overlaps(discriminator.defaultIds, member.ids)) return type
    const mapped = discriminator.mapping
      .filter((m) => overlaps(m.ids, member.ids))
      .map((m) => m.value)
    if (mapped.length > 0) explicit = true
    for (const value of mapped.length > 0
      ? mapped
      : member.name === undefined
        ? []
        : [member.name]) {
      found.add(value)
    }
  }
  if (found.size === 0) return type
  // Whether the schema already fixes the property is only known once every
  // declaration is built; see `applyNarrowing`.
  return {
    kind: "narrow",
    type,
    property: discriminator.property,
    values: [...found],
    explicit,
    location: schemas.context.documents.locate(at.document, at.pointer),
  }
}

/**
 * Apply a recorded discriminator narrowing, now that declarations are built. A schema that already
 * fixes the property to string literals keeps them.
 */
export function applyNarrowing(
  node: Extract<Type, { kind: "narrow" }>,
  report: (message: string, location: string) => void,
): Type {
  const { type, property } = node
  const declared = propertyLiterals(type, property, new Set())
  if (declared === "not-object" || declared === "not-string") {
    report(
      declared === "not-object"
        ? `Discriminator "${property}" cannot narrow this schema because it does not describe an object`
        : `Discriminator "${property}" cannot narrow this schema because the property is not a string`,
      node.location,
    )
    return type
  }
  let values = node.values
  if (declared !== "open") {
    const common = values.filter((v) => declared.has(v))
    if (common.length === 0) {
      if (node.explicit) {
        report(
          `Discriminator maps ${values.map((v) => JSON.stringify(v)).join(", ")} here, but "${property}" only allows ${[...declared].map((v) => JSON.stringify(v)).join(", ")}; the schema wins`,
          node.location,
        )
      }
      return type
    }
    if (common.length === declared.size) return type
    values = common
  }
  const tagged = intersect([
    type,
    {
      kind: "object",
      fields: [{ name: property, required: true, type: union(values.map((v) => literal(v))) }],
    },
  ])
  // Values that are not objects (a nullable branch's null) carry no property to narrow.
  return union([tagged, ...nonObjects(type, new Set())])
}

/** The members of a type that are definitely not objects, looking through references. */
function nonObjects(type: Type, seen: Set<Type>): Type[] {
  if (seen.has(type)) return []
  seen.add(type)
  switch (type.kind) {
    case "ref":
      return nonObjects(type.target.type, seen)
    case "narrow":
      return nonObjects(type.type, seen)
    case "union":
      return type.members.flatMap((m) => nonObjects(m, seen))
    case "null":
    case "boolean":
    case "string":
    case "number":
    case "binary":
    case "array":
    case "tuple":
      return [type]
    case "literal":
      return isRecord(type.value) ? [] : [type]
    default:
      return []
  }
}

type Literals = Set<string> | "open" | "not-string" | "not-object"

/** The string literals a type allows for an object property. */
function propertyLiterals(type: Type, property: string, seen: Set<Type>): Literals {
  if (seen.has(type)) return "open"
  seen.add(type)
  switch (type.kind) {
    case "object": {
      const field = type.fields.find((f) => f.name === property)
      return field ? stringLiterals(field.type, new Set()) : "open"
    }
    case "ref":
      return propertyLiterals(type.target.type, property, seen)
    case "narrow":
      return narrowed(propertyLiterals(type.type, property, seen), type)
    case "intersection":
      return meet(type.members.map((m) => propertyLiterals(m, property, seen)))
    case "union":
      return join(type.members.map((m) => propertyLiterals(m, property, seen)))
    case "literal":
      return isRecord(type.value)
        ? stringLiterals(literal(type.value[property]), new Set())
        : "not-object"
    case "unknown":
    case "never":
      return "open"
    default:
      return "not-object"
  }
}

/** The string literals a property type allows. */
function stringLiterals(type: Type, seen: Set<Type>): Literals {
  if (seen.has(type)) return "open"
  seen.add(type)
  switch (type.kind) {
    case "literal":
      return typeof type.value === "string" ? new Set([type.value]) : "not-string"
    case "ref":
      return stringLiterals(type.target.type, seen)
    case "narrow":
      return stringLiterals(type.type, seen)
    case "union":
      return join(type.members.map((m) => stringLiterals(m, seen)))
    case "intersection":
      return meet(type.members.map((m) => stringLiterals(m, seen)))
    case "string":
    case "unknown":
    case "never":
      return "open"
    default:
      return "not-string"
  }
}

/** A narrowing not yet applied contributes its values. */
function narrowed(inner: Literals, node: Extract<Type, { kind: "narrow" }>): Literals {
  if (inner === "open") return new Set(node.values)
  if (inner instanceof Set) {
    const common = node.values.filter((v) => inner.has(v))
    return common.length > 0 ? new Set(common) : inner
  }
  return inner
}

function meet(results: Literals[]): Literals {
  if (results.includes("not-object")) return "not-object"
  const sets = results.filter((r): r is Set<string> => r instanceof Set)
  if (sets.length > 0) return new Set([...sets[0]].filter((v) => sets.every((s) => s.has(v))))
  return results.includes("not-string") ? "not-string" : "open"
}

function join(results: Literals[]): Literals {
  if (results.every((r) => r === "not-object")) return "not-object"
  const relevant = results.filter((r) => r !== "not-object")
  if (relevant.includes("open")) return "open"
  const sets = relevant.filter((r): r is Set<string> => r instanceof Set)
  // Members that cannot hold a string never match a string discriminator value.
  return sets.length > 0 ? unionOf(sets) : "not-string"
}

/** Targets of a chain of references starting at `node` (excluding `node`). */
function refChain(schemas: SchemaBuilder, node: DocumentNode): DocumentNode[] {
  const out: DocumentNode[] = []
  const seen = new Set<string>()
  let current = node
  let reference = referencesOf(current.value)[0]
  while (reference !== undefined) {
    const resolution = schemas.context.documents.resolveSchema(reference[1], current)
    if (resolution.kind !== "found") break
    const id = identity(resolution.node)
    if (seen.has(id)) break
    seen.add(id)
    out.push(resolution.node)
    current = resolution.node
    reference = referencesOf(current.value)[0]
  }
  return out
}

/** Schemas reachable through `allOf` references, nearest first. */
function allOfParents(
  schemas: SchemaBuilder,
  node: DocumentNode,
  seen: Set<string>,
): DocumentNode[] {
  const schema = node.value
  if (!isRecord(schema) || !Array.isArray(schema.allOf)) return []
  const out: DocumentNode[] = []
  const later: DocumentNode[] = []
  schema.allOf.forEach((_, i) => {
    const target = refChain(schemas, schemas.context.documents.child(node, "allOf", i)).at(-1)
    if (target === undefined || seen.has(identity(target))) return
    seen.add(identity(target))
    out.push(target)
    later.push(target)
  })
  for (const parent of later) out.push(...allOfParents(schemas, parent, seen))
  return out
}

const families = new WeakMap<SchemaBuilder, Map<string, Member[]>>()

/** Entry-document components extending (via `allOf`, transitively) the schema with `selfIds`. */
function descendants(schemas: SchemaBuilder, selfIds: string[]): Member[] {
  let children = families.get(schemas)
  if (children === undefined) {
    children = new Map()
    const components = schemas.context.documents.child(
      schemas.context.documents.root(schemas.context.documents.entry),
      "components",
      "schemas",
    )
    for (const name of isRecord(components.value) ? Object.keys(components.value) : []) {
      const node = schemas.context.documents.child(components, name)
      const member = {
        ids: new Set([identity(node), ...refChain(schemas, node).map((n) => identity(n))]),
        name,
      }
      const schema = (refChain(schemas, node).at(-1) ?? node).value
      if (!isRecord(schema) || !Array.isArray(schema.allOf)) continue
      const owner = refChain(schemas, node).at(-1) ?? node
      schema.allOf.forEach((_, i) => {
        for (const parent of refChain(
          schemas,
          schemas.context.documents.child(owner, "allOf", i),
        )) {
          const list = children?.get(identity(parent)) ?? []
          list.push(member)
          children?.set(identity(parent), list)
        }
      })
    }
    families.set(schemas, children)
  }
  const out: Member[] = []
  const seen = new Set(selfIds)
  const queue = [...selfIds]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const child of children.get(id) ?? []) {
      if ([...child.ids].some((c) => seen.has(c))) continue
      for (const c of child.ids) seen.add(c)
      out.push(child)
      queue.push(...child.ids)
    }
  }
  return out
}

function unionOf(sets: Array<Set<string>>): Set<string> {
  const out = new Set<string>()
  for (const set of sets) for (const value of set) out.add(value)
  return out
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return true
  return false
}
