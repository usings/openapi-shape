import type { TypeNode } from "./model"
import { isRecord } from "./object"
import { intersect, literal, union } from "./type-algebra"
type Literals = Set<string> | "open" | "not-string" | "not-object"
/**
 * Apply a recorded discriminator narrowing, now that declarations are built. A schema that already
 * fixes the property to string literals constrains the narrowing to their intersection.
 */
export function applyNarrowing(
  node: Extract<TypeNode, { kind: "narrow" }>,
  report: (message: string, location: string) => void,
): TypeNode {
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
function nonObjects(type: TypeNode, seen: Set<TypeNode>): TypeNode[] {
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

/** The string literals a type allows for an object property. */
function propertyLiterals(type: TypeNode, property: string, seen: Set<TypeNode>): Literals {
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
function stringLiterals(type: TypeNode, seen: Set<TypeNode>): Literals {
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
function narrowed(inner: Literals, node: Extract<TypeNode, { kind: "narrow" }>): Literals {
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

function unionOf(sets: Array<Set<string>>): Set<string> {
  const out = new Set<string>()
  for (const set of sets) for (const value of set) out.add(value)
  return out
}
