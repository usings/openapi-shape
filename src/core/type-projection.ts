import type { Encoding, Field, Side, TypeDeclaration, TypeNode } from "./model"
import { uniqueName } from "./naming"

/** A schema's values and the values of one transport are distinct projections. */
type Wire = "json" | "multipart" | "part" | "item"

export class TypeProjection {
  readonly declarations: TypeDeclaration[] = []
  private readonly cache = new Map<TypeDeclaration, Map<string, TypeDeclaration>>()
  private readonly names: Set<string>

  constructor(declarations: TypeDeclaration[]) {
    this.names = new Set(
      declarations.flatMap((d) => [d.name, ...(d.inputName ? [d.inputName] : [])]),
    )
    for (const declaration of declarations) this.reference(declaration, "response", "json")
    for (const declaration of declarations) {
      if (declaration.inputName) this.reference(declaration, "request", "json")
    }
  }

  type(type: TypeNode, side: Side, wire: Wire = "json"): TypeNode {
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

  multipart(type: TypeNode, encodings?: Record<string, Encoding>): TypeNode {
    if (!encodings || !Object.values(encodings).some((encoding) => styled(encoding)))
      return this.type(type, "request", "multipart")
    const visit = (value: TypeNode, seen = new Set<TypeDeclaration>()): TypeNode => {
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

  private reference(source: TypeDeclaration, side: Side, wire: Wire): TypeDeclaration {
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
    const declaration: TypeDeclaration = {
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

function binaryProjection(type: TypeNode, wire: Wire, seen: Set<TypeDeclaration>): boolean {
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
