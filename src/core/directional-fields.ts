import type { Field, Side, TypeDeclaration, TypeNode } from "./model"
import { UNKNOWN } from "./model"

// Bits name the side on which a requirement is relaxed, not the annotation's applicable side.
const REQUEST = 1
const RESPONSE = 2
const BOTH = REQUEST | RESPONSE
const MAX_SCOPES = 64
const MAX_STEPS = 4096

interface Property {
  possible: number
  certain: number
  required: number
}
type Summary = Map<string, Property>
const EMPTY: Property = { possible: 0, certain: 0, required: 0 }

function relaxed(side: Side | "both"): number {
  if (side === "both") return BOTH
  return side === "response" ? REQUEST : RESPONSE
}

function required(field: Field): number {
  return !field.required ? 0 : field.requiredOnly ? BOTH ^ relaxed(field.requiredOnly) : BOTH
}

/** Annotations on this object level survive normalization until all enclosing scopes are known. */
export function hasDirections(
  type: TypeNode,
  available: (declaration: TypeDeclaration) => boolean,
  seen = new Set<TypeDeclaration>(),
): boolean {
  switch (type.kind) {
    case "unknown":
      return (type.directions?.length ?? 0) > 0
    case "object":
      return type.fields.some((f) => f.direction !== undefined)
    case "union":
    case "intersection":
      return type.members.some((m) => hasDirections(m, available, seen))
    case "ref":
      // Defer absorption by unknown until the referenced annotations are known.
      if (!available(type.target)) return true
      if (seen.has(type.target)) return false
      seen.add(type.target)
      return hasDirections(type.target.type, available, seen)
    default:
      return false
  }
}

/**
 * Resolve one object-level conjunction. Split only alternatives whose annotations can relax a
 * requirement here. References are copied only when a use-site requirement changes; property values
 * start a new scope and are never traversed. All memoization belongs to this invocation.
 */
export function directionScopes(
  members: TypeNode[],
  available: (declaration: TypeDeclaration) => boolean,
  widen: (reason: string) => void,
): TypeNode[][] {
  const memo = new Map<TypeNode, Summary>()
  const summarize = (type: TypeNode): Summary => {
    const cached = memo.get(type)
    if (cached) return cached
    const out: Summary = new Map()
    memo.set(type, out)
    if (type.kind === "ref") {
      if (available(type.target)) combine(out, summarize(type.target.type))
    } else if (type.kind === "unknown") {
      for (const field of type.directions ?? []) {
        const annotation = relaxed(field.direction)
        out.set(field.name, { possible: annotation, certain: annotation, required: 0 })
      }
    } else if (type.kind === "object") {
      for (const field of type.fields) {
        const annotation = field.direction ? relaxed(field.direction) : 0
        out.set(field.name, {
          possible: annotation,
          certain: annotation,
          required: required(field),
        })
      }
    } else if (type.kind === "intersection" || type.kind === "union") {
      const children = type.members.map(summarize)
      for (const child of children) combine(out, child)
      if (type.kind === "union") {
        for (const [name, property] of out) {
          property.certain = children.reduce(
            (mask, child) => mask & (child.get(name)?.certain ?? 0),
            BOTH,
          )
        }
      }
    }
    return out
  }
  const combined: Summary = new Map()
  for (const member of members) combine(combined, summarize(member))
  const relevant = new Set(
    [...combined].filter(([, p]) => (p.possible & p.required) !== 0).map(([name]) => name),
  )
  if (relevant.size === 0) return [members]

  const mixed = (type: TypeNode): boolean =>
    [...summarize(type)].some(
      ([name, p]) =>
        relevant.has(name) &&
        p.possible !== p.certain &&
        (p.possible & ~(combined.get(name)?.certain ?? 0)) !== 0,
    )
  let steps = 0
  const split = (type: TypeNode): TypeNode[][] | undefined => {
    if (++steps > MAX_STEPS) return undefined
    if (!mixed(type)) return [[type]]
    switch (type.kind) {
      case "ref":
        return split(type.target.type)
      case "union": {
        const out: TypeNode[][] = []
        for (const member of type.members) {
          const branches = split(member)
          if (!branches || out.length + branches.length > MAX_SCOPES) return undefined
          out.push(...branches)
        }
        return out
      }
      case "intersection":
        return product(type.members)
      default:
        return [[type]]
    }
  }
  const product = (types: TypeNode[]): TypeNode[][] | undefined => {
    let scopes: TypeNode[][] = [[]]
    for (const type of types) {
      const branches = split(type)
      if (!branches || scopes.length * branches.length > MAX_SCOPES) return undefined
      const next: TypeNode[][] = []
      for (const scope of scopes) for (const branch of branches) next.push([...scope, ...branch])
      scopes = next
    }
    return scopes
  }
  const scopes = product(members)
  if (!scopes) {
    widen(
      "Directional requiredness exceeds 64 branch scopes or 4,096 traversal steps; affected requirements are relaxed across the alternatives to retain valid values",
    )
    return [relax(members, combined, true)]
  }
  return scopes.map((scope) => {
    const summary: Summary = new Map()
    for (const type of scope) combine(summary, summarize(type))
    return relax(scope, summary, false)
  })

  function relax(types: TypeNode[], summary: Summary, possible: boolean): TypeNode[] {
    const copies = new Map<TypeNode, TypeNode>()
    const maskFor = (name: string): number => {
      const property = summary.get(name) ?? EMPTY
      return possible ? property.possible : property.certain
    }
    const visit = (type: TypeNode): TypeNode => {
      const cached = copies.get(type)
      if (cached) return cached
      // A recursive reference alone cannot establish an additional requirement.
      copies.set(type, type)
      if (![...summarize(type)].some(([name, p]) => (p.required & maskFor(name)) !== 0)) return type
      let out = type
      if (type.kind === "ref") out = visit(type.target.type)
      else if (type.kind === "union" || type.kind === "intersection") {
        out = { ...type, members: type.members.map(visit) }
      } else if (type.kind === "object") {
        out = {
          ...type,
          fields: type.fields.map((field) => {
            const before = required(field)
            const after = before & ~maskFor(field.name)
            if (before === after) return field
            return {
              ...field,
              required: after !== 0,
              requiredOnly:
                after === REQUEST ? "request" : after === RESPONSE ? "response" : undefined,
            }
          }),
        }
      }
      copies.set(type, out)
      return out
    }
    return types.map(visit)
  }
}

function combine(target: Summary, source: Summary): void {
  for (const [name, property] of source) {
    const prior = target.get(name) ?? EMPTY
    target.set(name, {
      possible: prior.possible | property.possible,
      certain: prior.certain | property.certain,
      required: prior.required | property.required,
    })
  }
}

/** Widen values without erasing annotations needed by requirements at later use sites. */
export function retainDirections(
  replacement: TypeNode,
  original: TypeNode,
  available: (declaration: TypeDeclaration) => boolean,
): TypeNode {
  const annotations = new Map<string, Side | "both">()
  const seen = new Set<TypeNode>()
  const visit = (type: TypeNode): void => {
    if (seen.has(type)) return
    seen.add(type)
    if (type.kind === "object" || type.kind === "unknown") {
      const fields = type.kind === "object" ? type.fields : (type.directions ?? [])
      for (const field of fields) {
        if (!field.direction) continue
        const previous = annotations.get(field.name)
        annotations.set(
          field.name,
          previous && previous !== field.direction ? "both" : field.direction,
        )
      }
    } else if (type.kind === "ref" && available(type.target)) visit(type.target.type)
    else if (type.kind === "intersection" || type.kind === "union") type.members.forEach(visit)
  }
  visit(original)
  if (annotations.size === 0) return replacement
  const directions = [...annotations].map(([name, direction]) => ({ name, direction }))
  // Once alternatives are widened away, relaxing every possibly annotated requirement is sound.
  if (replacement.kind === "unknown") return { ...replacement, directions }
  if (replacement.kind === "object") {
    return {
      ...replacement,
      fields: [
        ...replacement.fields,
        ...directions.map(({ name, direction }) => ({
          name,
          direction,
          type: UNKNOWN,
          required: false,
        })),
      ],
    }
  }
  return replacement
}
