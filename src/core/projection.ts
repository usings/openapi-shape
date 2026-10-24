import type { Diagnostics } from "./diagnostics"
import type { Declaration, Encoding, Field, Model, Operation, Side, Type } from "./model"
import { childTypes } from "./model"
import { uniqueName } from "./naming"

/** A schema's values and the values of one transport are distinct projections. */
type Wire = "json" | "multipart" | "part" | "item"

export class Projection {
  readonly declarations: Declaration[] = []
  private readonly cache = new Map<Declaration, Map<string, Declaration>>()
  private readonly names: Set<string>

  constructor(declarations: Declaration[]) {
    this.names = new Set(
      declarations.flatMap((d) => [d.name, ...(d.inputName ? [d.inputName] : [])]),
    )
    for (const declaration of declarations) this.reference(declaration, "response", "json")
    for (const declaration of declarations) {
      if (declaration.inputName) this.reference(declaration, "request", "json")
    }
  }

  type(type: Type, side: Side, wire: Wire = "json"): Type {
    switch (type.kind) {
      case "binary":
        return wire === "part" || wire === "item" ? type : { kind: "string" }
      case "ref":
        return { kind: "ref", target: this.reference(type.target, side, wire) }
      case "object":
        return {
          ...type,
          fields: type.fields.map((field) =>
            this.field(field, side, wire === "multipart" ? "part" : "json"),
          ),
          ...(type.additional
            ? {
                additional: this.type(
                  type.additional,
                  side,
                  wire === "multipart" ? "part" : "json",
                ),
              }
            : {}),
          ...(type.patterns
            ? {
                patterns: type.patterns.map((p) => ({
                  ...p,
                  type: this.type(p.type, side, wire === "multipart" ? "part" : "json"),
                })),
              }
            : {}),
        }
      case "array":
        return { ...type, items: this.type(type.items, side, wire === "part" ? "item" : "json") }
      case "tuple":
        return {
          ...type,
          items: type.items.map((t) => this.type(t, side, wire === "part" ? "item" : "json")),
          ...(type.rest
            ? { rest: this.type(type.rest, side, wire === "part" ? "item" : "json") }
            : {}),
        }
      case "union":
      case "intersection":
        return { ...type, members: type.members.map((t) => this.type(t, side, wire)) }
      case "narrow":
        throw new Error("Discriminator narrowing must finish before projection")
      default:
        return type
    }
  }

  multipart(type: Type, encodings?: Record<string, Encoding>): Type {
    if (!encodings || !Object.values(encodings).some((encoding) => styled(encoding)))
      return this.type(type, "request", "multipart")
    const visit = (value: Type, seen = new Set<Declaration>()): Type => {
      if (value.kind === "ref") {
        if (seen.has(value.target)) return this.type(value, "request", "multipart")
        return visit(value.target.type, new Set(seen).add(value.target))
      }
      if (value.kind === "union" || value.kind === "intersection")
        return { ...value, members: value.members.map((m) => visit(m, seen)) }
      if (value.kind !== "object") return this.type(value, "request", "multipart")
      const result = this.type(value, "request", "multipart")
      if (result.kind !== "object") return result
      return {
        ...result,
        fields: value.fields.map((f) =>
          this.field(
            f,
            "request",
            Object.hasOwn(encodings, f.name) && styled(encodings[f.name]) ? "json" : "part",
          ),
        ),
      }
    }
    return visit(type)
  }

  field(field: Field, side: Side, wire: Wire = "json"): Field {
    const { requiredOnly, direction: _direction, ...rest } = field
    return {
      ...rest,
      required: field.required && (requiredOnly === undefined || requiredOnly === side),
      type: this.type(field.type, side, wire),
    }
  }

  private reference(source: Declaration, side: Side, wire: Wire): Declaration {
    // Input variants are needed only where directional requiredness reaches this declaration.
    const input = side === "request" && source.inputName !== undefined
    const binary = wire !== "json" && binaryProjection(source.type, wire, new Set())
    const key = `${input ? "request" : "response"}:${binary ? wire : "json"}`
    let variants = this.cache.get(source)
    if (!variants) {
      variants = new Map()
      this.cache.set(source, variants)
    }
    const existing = variants.get(key)
    if (existing) return existing
    const base = input ? (source.inputName ?? source.name) : source.name
    const name = binary
      ? uniqueName(`${base}${wire === "multipart" ? "Multipart" : "Binary"}`, this.names)
      : base
    this.names.add(name)
    const declaration: Declaration = {
      name,
      type: { kind: "unknown" },
      complete: true,
      ...(source.annotations ? { annotations: source.annotations } : {}),
    }
    variants.set(key, declaration)
    this.declarations.push(declaration)
    declaration.type = this.type(
      source.type,
      input ? "request" : "response",
      binary ? wire : "json",
    )
    return declaration
  }
}

function binaryProjection(type: Type, wire: Wire, seen: Set<Declaration>): boolean {
  switch (type.kind) {
    case "binary":
      return wire === "part" || wire === "item"
    case "ref":
      if (seen.has(type.target)) return false
      return binaryProjection(type.target.type, wire, new Set(seen).add(type.target))
    case "object":
      return (
        wire === "multipart" &&
        [
          ...type.fields.map((f) => f.type),
          ...(type.additional ? [type.additional] : []),
          ...(type.patterns ?? []).map((p) => p.type),
        ].some((t) => binaryProjection(t, "part", seen))
      )
    case "array":
      return binaryProjection(type.items, wire === "part" ? "item" : "json", seen)
    case "tuple":
      return [...type.items, ...(type.rest ? [type.rest] : [])].some((t) =>
        binaryProjection(t, wire === "part" ? "item" : "json", seen),
      )
    case "union":
    case "intersection":
      return type.members.some((t) => binaryProjection(t, wire, seen))
    default:
      return false
  }
}

function styled(encoding: Encoding): boolean {
  return (
    encoding.style !== undefined ||
    encoding.explode !== undefined ||
    encoding.allowReserved !== undefined
  )
}

/** Name directional variants only for declarations used in outgoing data. */
export function assignInputVariants(model: Model, diagnostics: Diagnostics): void {
  const sent = [
    ...model.endpoints.flatMap((op) => requestTypes(op)),
    ...[...model.webhooks, ...model.callbacks].flatMap((op) => responseTypes(op)),
  ]
  for (const declaration of assignInputNames(model.declarations, sent)) {
    if (declaration.inputName !== `${declaration.name}Input`) {
      diagnostics.warn(
        "renamed-schema",
        `The request-side variant of ${declaration.name} is emitted as ${declaration.inputName} because ${declaration.name}Input is already taken`,
        declaration.location ?? "#",
      )
    }
  }
}

function requestTypes(op: Operation): Type[] {
  return [
    ...[...op.params, ...op.query, ...op.headers, ...op.cookies].map((f) => f.type),
    ...(op.querystring ? [op.querystring.type] : []),
    ...(op.body?.content ?? []).map((media) => media.type),
  ]
}

function responseTypes(op: Operation): Type[] {
  return op.responses.flatMap((r) => [
    ...r.content.map((media) => media.type),
    ...r.headers.map((f) => f.type),
  ])
}

/**
 * Give a request-side name to declarations whose required properties differ between the two sides
 * (readOnly/writeOnly), when something the client sends (`sent`) uses them.
 */
function assignInputNames(declarations: Declaration[], sent: Type[]): Declaration[] {
  const differs = new Set<Declaration>()
  for (let changed = true; changed;) {
    changed = false
    for (const declaration of declarations) {
      if (!differs.has(declaration) && hasOneSidedField(declaration.type, differs, new Set())) {
        differs.add(declaration)
        changed = true
      }
    }
  }
  if (differs.size === 0) return []

  const used = new Set<Declaration>()
  const mark = (type: Type): void =>
    forEachRef(type, (target) => {
      if (!differs.has(target) || used.has(target)) return
      used.add(target)
      mark(target.type)
    })
  for (const type of sent) mark(type)

  const taken = new Set(declarations.map((d) => d.name))
  const variants: Declaration[] = []
  for (const declaration of declarations) {
    if (!used.has(declaration)) continue
    declaration.inputName = uniqueName(`${declaration.name}Input`, taken)
    taken.add(declaration.inputName)
    variants.push(declaration)
  }
  return variants
}

function hasOneSidedField(type: Type, differs: Set<Declaration>, seen: Set<Type>): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.kind === "ref") return differs.has(type.target)
  if (type.kind === "object" && type.fields.some((f) => f.requiredOnly !== undefined)) return true
  return childTypes(type).some((t) => hasOneSidedField(t, differs, seen))
}

function forEachRef(type: Type, visit: (target: Declaration) => void): void {
  if (type.kind === "ref") visit(type.target)
  for (const child of childTypes(type)) forEachRef(child, visit)
}
