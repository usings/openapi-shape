import { directionScopes, hasDirections, retainDirections } from "./directions"
import type { Declaration, Field, Literal, Type } from "./model"
import { NEVER, UNKNOWN, TYPE_LOCATION } from "./model"
import { matchesPattern } from "./patterns"

/** Normalized union: flattened, deduplicated, with absorbed members removed. */
export function union(members: Type[]): Type {
  const flat: Type[] = []
  for (const member of members) {
    if (member.kind === "union") flat.push(...member.members)
    else flat.push(member)
  }
  if (
    flat.some((t) => t.kind === "unknown") &&
    !flat.some((t) => hasDirections(t, (d) => sealed.has(d)))
  ) {
    return flat.some((t) => t.kind === "unknown" && t.widened) ? WIDENED_UNKNOWN : UNKNOWN
  }
  let out = dedupe(flat.filter((t) => t.kind !== "never"))

  const has = (kind: "string" | "number" | "boolean"): boolean => out.some((t) => t.kind === kind)
  const absorbs = { string: has("string"), number: has("number"), boolean: has("boolean") }
  out = out.filter((t) => {
    if (t.kind !== "literal") return true
    const kind = typeof t.value
    return !(kind === "string" || kind === "number" || kind === "boolean") || !absorbs[kind]
  })
  if (!absorbs.boolean && hasLiteral(out, true) && hasLiteral(out, false)) {
    const at = out.findIndex((t) => t.kind === "literal" && typeof t.value === "boolean")
    out = out.filter((t) => !(t.kind === "literal" && typeof t.value === "boolean"))
    out.splice(at, 0, { kind: "boolean" })
  }

  if (out.length === 0) return NEVER
  if (out.length === 1) return out[0]
  return { kind: "union", members: out }
}

interface IntersectionContext {
  location?: string
  onWiden?: (location: string | undefined, reason?: string) => void
}

/** Normalized intersection: flattened, scalar conflicts resolved, plain objects merged. */
export function intersect(members: Type[], context?: IntersectionContext): Type {
  return intersectScoped(members, context, true)
}

function intersectScoped(
  members: Type[],
  context: IntersectionContext | undefined,
  directions: boolean,
): Type {
  const flat: Type[] = []
  for (const member of members) {
    if (member.kind === "intersection") flat.push(...member.members)
    else flat.push(member)
  }
  if (flat.some((t) => t.kind === "never")) return NEVER
  let out = dedupe(flat.filter((t) => t.kind !== "unknown" || t.widened || t.directions))

  if (directions) {
    const scopes = directionScopes(
      out,
      (declaration) => sealed.has(declaration),
      (reason) => context?.onWiden?.(context.location, reason),
    )
    if (scopes.length > 1)
      return union(scopes.map((scope) => intersectScoped(scope, context, false)))
    out = scopes[0]
  }

  // TypeScript expands intersections of unions, also those behind references,
  // into every combination and gives up past a limit; widen the largest unions
  // (soundly) until it fits.
  for (;;) {
    const sizes = out.map((t) => expansions(t))
    if (sizes.reduce((n, size) => n * size, 1) <= MAX_COMBINATIONS) break
    context?.onWiden?.(context.location)
    const largest = sizes.indexOf(Math.max(...sizes))
    // A union of objects widens to any object, which keeps its properties allowed.
    // Retain widening through enclosing compositions until implied shapes have yielded to it.
    out = out.map((t, i) =>
      i !== largest
        ? t
        : retainDirections(
            shapeOf(t) === "object" ? OPEN_OBJECT : WIDENED_UNKNOWN,
            t,
            (declaration) => sealed.has(declaration),
          ),
    )
  }

  // An implied shape gives way to the alternatives a referenced union allows,
  // one level deep: below, alternatives would multiply level by level, and a
  // recursive union would never end.
  const implied = out.some((t) => isImplied(t))
  if (implied && lookingThrough) {
    // Deeper, where the union could be looked through and mixes objects with
    // other values, which the implied shape would shut out, the type widens
    // to either side instead.
    const opaque = out.filter((t) => {
      const behind = t.kind === "ref" ? unionBehind(t) : undefined
      return (
        behind !== undefined &&
        behind.members.length <= MAX_DISTRIBUTION &&
        shapeOf(t) === undefined
      )
    })
    if (opaque.length > 0) {
      context?.onWiden?.(
        context.location,
        "Nested mixed references exceed the one-level distribution boundary; implied shape constraints are widened to retain other value types",
      )
      return union([
        intersect(
          out.filter((t) => !opaque.includes(t)),
          context,
        ),
        ...opaque,
      ])
    }
  }
  let lookedThrough = false
  if (implied && !lookingThrough) {
    out = out.map((t) => {
      const behind = t.kind === "ref" ? unionBehind(t) : undefined
      if (!behind || behind.members.length > MAX_DISTRIBUTION) return t
      lookedThrough = true
      return behind
    })
  }
  if (!lookedThrough) return simplify(out, implied, context)
  lookingThrough = true
  try {
    return simplify(out, implied, context)
  } finally {
    lookingThrough = false
  }
}

/** Whether an enclosing `intersect` is distributing a union it looked through a reference for. */
let lookingThrough = false

function simplify(members: Type[], implied: boolean, context?: IntersectionContext): Type {
  let out = members

  // `{ a?, b? } & ({ a } | { b })` reads better as `{ a, b? } | { a?, b }`, as long
  // as the alternatives stay few.
  const alternatives = out.filter((t) => isDistributable(t, implied))
  const product = alternatives.reduce((n, t) => n * (t.kind === "union" ? t.members.length : 1), 1)
  if (
    alternatives.length > 0 &&
    product <= MAX_DISTRIBUTION &&
    out.some(
      (t) =>
        !isDistributable(t, implied) &&
        (shapeOf(t) !== undefined || t.kind === "object" || isArrayLike(t)),
    )
  ) {
    const first = alternatives[0] as Extract<Type, { kind: "union" }>
    const rest = out.filter((t) => t !== first)
    return union(first.members.map((member) => intersect([...rest, member], context)))
  }

  // Type-specific keywords without `type` constrain only their own type.
  const shapes = out.map((t) => shapeOf(t))
  // Unexpanded constraints may admit other shapes, whether they are unions,
  // intersections, or references to a widened type. Infer their rendered shape
  // without requiring a particular composition structure. Defer unsealed refs.
  const opaqueShapes =
    implied && shapes.every((shape) => shape === undefined)
      ? out
          .filter(
            (t) =>
              !isImplied(t) &&
              (t.kind !== "ref" || sealed.has(t.target)) &&
              (t.kind !== "unknown" || t.widened),
          )
          .map((t) => shapeOf(t, new Map(), true))
      : []
  const definiteNonObject =
    shapes.some((s) => s !== undefined && s !== "object") ||
    opaqueShapes.some((s) => s !== "object")
  const definiteNonArray =
    shapes.some((s) => s !== undefined && s !== "array") || opaqueShapes.some((s) => s !== "array")
  if (
    shapes.every((shape) => shape === undefined) &&
    out.some(
      (t) =>
        (definiteNonObject && t.kind === "object" && t.inferred) ||
        (definiteNonArray && isArrayLike(t) && t.inferred),
    )
  ) {
    context?.onWiden?.(
      context.location,
      "An unexpanded mixed constraint may accept other value types; implied object or array constraints are omitted at this intersection. Add an explicit type if the contract intends to restrict the shape",
    )
  }
  out = out
    .map((t) =>
      (definiteNonObject && t.kind === "object" && t.inferred) ||
      (definiteNonArray && isArrayLike(t) && t.inferred)
        ? retainDirections(UNKNOWN, t, (declaration) => sealed.has(declaration))
        : t,
    )
    .filter((t) => t.kind !== "unknown" || t.directions)

  // A JSON value has one type: different definite shapes cannot meet.
  const definite = new Set(out.map((t) => shapeOf(t)).filter((s) => s !== undefined))
  const scalars = out.filter((t) => isScalar(t))
  if (definite.has("object") && definite.has("array")) return NEVER
  if (scalars.length > 0) {
    if (definite.has("object") || definite.has("array")) return NEVER
    const scalar = intersectScalars(scalars)
    if (scalar.kind === "never") return NEVER
    out = replaceAll(out, isScalar, [scalar])
  }
  // `type: object` alone adds nothing next to another object.
  if (out.some((t) => shapeOf(t) === "object" && !isBareObject(t)))
    out = out.filter((t) => !isBareObject(t))

  const objects = out.filter((t) => t.kind === "object")
  if (objects.length > 1)
    out = replaceAll(out, (t) => t.kind === "object", [mergeObjects(objects, context)])

  const arrays = out.filter((t) => t.kind === "array")
  if (arrays.length > 1) {
    const items = intersect(
      arrays.map((t) => (t.kind === "array" ? t.items : UNKNOWN)),
      context,
    )
    const inferred = arrays.every((t) => t.kind === "array" && t.inferred)
    out = replaceAll(out, (t) => t.kind === "array", [
      inferred ? { kind: "array", items, inferred } : { kind: "array", items },
    ])
  }

  if (out.length === 0) {
    return members.some((t) => t.kind === "unknown" && t.widened) ? WIDENED_UNKNOWN : UNKNOWN
  }
  if (out.length === 1) return out[0]
  return {
    kind: "intersection",
    members: out,
    ...(context?.location ? { [TYPE_LOCATION]: context.location } : {}),
  }
}

export function literal(value: unknown): Type {
  return { kind: "literal", value: toLiteral(value) }
}

/** Whether `value` is a JSON value (the only values a schema literal can hold). */
export function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v))
  if (typeof value === "object") return Object.values(value).every((v) => isJsonValue(v))
  return false
}

/** Whether a JSON value is an instance of a JSON Schema primitive type name. */
export function isOfType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null
    case "boolean":
      return typeof value === "boolean"
    case "integer":
      return Number.isInteger(value)
    case "number":
      return typeof value === "number"
    case "string":
      return typeof value === "string"
    case "array":
      return Array.isArray(value)
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    default:
      return false
  }
}

/** JSON equality membership, as `enum` and `const` define it. */
export function includesJson(values: unknown[], value: unknown): boolean {
  const key = canonicalJson(value)
  return values.some((v) => canonicalJson(v) === key)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** Structural identity of a type; declarations compare by identity. */
function typeKey(type: Type): string {
  // Documentation does not affect identity; declarations compare by reference.
  return JSON.stringify(type, (key, value: unknown) =>
    key === "annotations"
      ? undefined
      : key === "target"
        ? `#${declarationId(value as Declaration)}`
        : value,
  )
}

const declarationIds = new WeakMap<Declaration, number>()
let nextDeclarationId = 0
function declarationId(declaration: Declaration): number {
  let id = declarationIds.get(declaration)
  if (id === undefined) {
    id = nextDeclarationId++
    declarationIds.set(declaration, id)
  }
  return id
}

function toLiteral(value: unknown): Literal {
  if (Array.isArray(value)) return value.map((v) => toLiteral(v))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toLiteral(v)]))
  }
  return value as Literal
}

function dedupe(types: Type[]): Type[] {
  const seen = new Set<string>()
  return types.filter((t) => {
    const key = typeKey(t)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hasLiteral(types: Type[], value: boolean): boolean {
  return types.some((t) => t.kind === "literal" && t.value === value)
}

function replaceAll(types: Type[], match: (t: Type) => boolean, replacement: Type[]): Type[] {
  const at = types.findIndex(match)
  const rest = types.filter((t) => !match(t))
  rest.splice(at, 0, ...replacement)
  return rest
}

type ScalarKind = "null" | "boolean" | "string" | "number" | "binary"

function scalarKind(type: Type): ScalarKind | undefined {
  switch (type.kind) {
    case "null":
    case "boolean":
    case "string":
    case "number":
    case "binary":
      return type.kind
    case "literal": {
      const value = type.value
      if (value === null) return "null"
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return typeof value as ScalarKind
      }
      return undefined
    }
    default:
      return undefined
  }
}

function isScalar(type: Type): boolean {
  return scalarKind(type) !== undefined
}

/** Any object: what a union of objects widens to. */
const OPEN_OBJECT: Type = { kind: "object", fields: [], additional: UNKNOWN }
const WIDENED_UNKNOWN: Type = { kind: "unknown", widened: true }

const MAX_DISTRIBUTION = 16
const MAX_COMBINATIONS = 10_000

/**
 * Declarations whose types are final. References are opaque while declarations are still being
 * built, so that simplification cannot depend on the order in which they are built.
 */
const sealed = new WeakSet<Declaration>()

export function seal(declarations: Declaration[]): void {
  for (const declaration of declarations) sealed.add(declaration)
}

type Shape = "object" | "array" | ScalarKind

/** The JSON type every value of `type` has, when there is exactly one. */
function shapeOf(
  type: Type,
  known = new Map<Declaration, Shape | undefined>(),
  includeInferred = false,
): Shape | undefined {
  switch (type.kind) {
    case "object":
      return type.inferred && !includeInferred ? undefined : "object"
    case "array":
    case "tuple":
      return type.inferred && !includeInferred ? undefined : "array"
    case "literal":
      if (Array.isArray(type.value)) return "array"
      if (typeof type.value === "object" && type.value !== null) return "object"
      return scalarKind(type)
    case "ref": {
      if (!sealed.has(type.target)) return undefined
      // Each declaration once per call; one that leads back to itself is open.
      if (known.has(type.target)) return known.get(type.target)
      known.set(type.target, undefined)
      const shape = shapeOf(type.target.type, known, includeInferred)
      known.set(type.target, shape)
      return shape
    }
    case "narrow":
      return shapeOf(type.type, known, includeInferred)
    case "intersection": {
      if (includeInferred) {
        const definite = shapeOf(type)
        if (definite !== undefined) return definite
        // An implied member must not mask a mixed constraint that will make it
        // yield when its declaration is normalized later.
        const shapes = new Set(type.members.map((m) => shapeOf(m, known, true)))
        const [only] = shapes
        return shapes.size === 1 ? only : undefined
      }
      for (const member of type.members) {
        const shape = shapeOf(member, known, includeInferred)
        if (shape !== undefined) return shape
      }
      return undefined
    }
    case "union": {
      const shapes = new Set(type.members.map((m) => shapeOf(m, known, includeInferred)))
      const [only] = shapes
      return shapes.size === 1 ? only : undefined
    }
    default:
      return scalarKind(type)
  }
}

function isBareObject(type: Type): boolean {
  return (
    type.kind === "object" &&
    type.fields.length === 0 &&
    type.additional === undefined &&
    (type.patterns ?? []).length === 0 &&
    !type.inferred
  )
}

/**
 * A union whose members an intersection can simplify with: objects, arrays, literals, scalars; and
 * references, where an implied shape must give way to them.
 */
function isDistributable(type: Type, references: boolean): boolean {
  return (
    type.kind === "union" &&
    type.members.length <= MAX_DISTRIBUTION &&
    type.members.every(
      (m) =>
        m.kind === "object" ||
        isArrayLike(m) ||
        m.kind === "literal" ||
        isScalar(m) ||
        (references && m.kind === "ref"),
    )
  )
}

/**
 * How many alternatives TypeScript expands a type into, through references to sealed declarations;
 * each declaration is counted once per call, and a reference back into itself counts as one.
 */
function expansions(type: Type, counted = new Map<Declaration, number>()): number {
  switch (type.kind) {
    case "union":
      return type.members.reduce((n, m) => n + expansions(m, counted), 0)
    case "intersection":
      return type.members.reduce((n, m) => n * expansions(m, counted), 1)
    case "ref": {
      if (!sealed.has(type.target)) return 1
      const known = counted.get(type.target)
      if (known !== undefined) return known
      counted.set(type.target, 1)
      const n = expansions(type.target.type, counted)
      counted.set(type.target, n)
      return n
    }
    default:
      return 1
  }
}

/** The union a type is, directly or through references to sealed declarations. */
function unionBehind(
  type: Type,
  seen = new Set<Declaration>(),
): Extract<Type, { kind: "union" }> | undefined {
  if (type.kind === "union") return type
  if (type.kind !== "ref" || !sealed.has(type.target) || seen.has(type.target)) return undefined
  seen.add(type.target)
  return unionBehind(type.target.type, seen)
}

function isArrayLike(type: Type): type is Extract<Type, { kind: "array" | "tuple" }> {
  return type.kind === "array" || type.kind === "tuple"
}

function isImplied(type: Type): boolean {
  return (type.kind === "object" || isArrayLike(type)) && type.inferred === true
}

function intersectScalars(scalars: Type[]): Type {
  let result: Type | undefined
  for (const scalar of scalars) {
    if (result === undefined) {
      result = scalar
      continue
    }
    result = intersectTwoScalars(result, scalar)
    if (result.kind === "never") return NEVER
  }
  return result ?? UNKNOWN
}

function intersectTwoScalars(a: Type, b: Type): Type {
  const kindA = scalarKind(a)
  const kindB = scalarKind(b)
  // OpenAPI 3.0 `format: binary` refines `type: string`.
  if (kindA === "binary" && (kindB === "binary" || b.kind === "string")) return a
  if (kindB === "binary" && a.kind === "string") return b
  if (kindA !== kindB) return NEVER
  if (a.kind === "literal" && b.kind === "literal") {
    return typeKey(a) === typeKey(b) ? a : NEVER
  }
  if (a.kind === "literal") return a
  if (b.kind === "literal") return b
  return a
}

function mergeObjects(objects: Type[], context?: IntersectionContext): Type {
  const members = objects.filter((t): t is Extract<Type, { kind: "object" }> => t.kind === "object")
  const merged = new Map<string, { types: Type[]; field: Field; sides: Field[] }>()
  for (const object of members) {
    for (const field of object.fields) {
      const entry = merged.get(field.name)
      if (entry) {
        entry.types.push(field.type)
        entry.sides.push(field)
      } else {
        merged.set(field.name, { types: [field.type], field, sides: [field] })
      }
    }
  }
  const fields: Field[] = []
  for (const [name, entry] of merged) {
    // A member that does not declare the property still constrains it through
    // its matching patterns, or else its additionalProperties.
    for (const object of members) {
      if (object.fields.some((f) => f.name === name)) continue
      const matches = (object.patterns ?? []).filter((p) => matchesPattern(p.pattern, name))
      if (matches.length > 0) entry.types.push(...matches.map((p) => p.type))
      else if (object.additional) entry.types.push(object.additional)
    }
    fields.push({
      ...entry.field,
      type: intersect(entry.types, context),
      ...requiredness(entry.sides),
      direction: combinedDirection(entry.sides),
    })
  }
  const out: Type = { kind: "object", fields }
  const additional = members.flatMap((t) => (t.additional ? [t.additional] : []))
  if (additional.length > 0) out.additional = intersect(additional, context)
  const patterns = members.flatMap((t) => t.patterns ?? [])
  if (patterns.length > 0) out.patterns = patterns
  if (members.every((t) => t.inferred)) out.inferred = true
  return out
}

function combinedDirection(fields: Field[]): Field["direction"] {
  const directions = new Set(fields.flatMap((f) => (f.direction ? [f.direction] : [])))
  return directions.size > 1 || directions.has("both") ? "both" : [...directions][0]
}

/** A property is required when any member requires it; one-sided only if every requirement is. */
function requiredness(sides: Field[]): Pick<Field, "required" | "requiredOnly"> {
  const requiring = sides.filter((f) => f.required)
  if (requiring.length === 0) return { required: false, requiredOnly: undefined }
  const only = requiring[0].requiredOnly
  const oneSided = only !== undefined && requiring.every((f) => f.requiredOnly === only)
  return { required: true, requiredOnly: oneSided ? only : undefined }
}
