import { indentTail, jsdoc } from "./jsdoc"
import type { Field, Literal, Type, Side } from "./model"
import { UNDEFINED, UNKNOWN } from "./model"
import { propertyKey } from "./naming"
import { union } from "./type-algebra"

export interface TypeContext {
  side: Side
  /** Prefix for declaration references: `Schemas.` outside the namespace, `""` inside. */
  refPrefix: string
  /** The global `Blob`, as named where a declaration may shadow it. */
  blob: string
}

// A union needs parentheses inside an intersection; both need them before `[]`.
const Precedence = { Union: 0, Intersection: 1, Atom: 2 } as const
type Precedence = (typeof Precedence)[keyof typeof Precedence]

interface Rendered {
  text: string
  precedence: Precedence
}

const MAX_INLINE_OBJECT = 100

export function renderType(type: Type, context: TypeContext): string {
  return render(type, context).text
}

/** The index signature value of an object type, if it has one (before widening). */
export function indexOf(type: Extract<Type, { kind: "object" }>): Type | undefined {
  const members = [
    ...(type.patterns ?? []).map((p) => p.type),
    ...(type.additional ? [type.additional] : []),
  ]
  if (members.length > 0) return union(members)
  // An object without declared members accepts any properties.
  return type.fields.length === 0 ? UNKNOWN : undefined
}

/** `{ a: string; b?: number }`, or one member per line when documented or long. */
export function renderFields(
  fields: Field[],
  index: Type | undefined,
  context: TypeContext,
  multiline = false,
): string {
  const lines = fields.map((field) => {
    const optional =
      !field.required || (field.requiredOnly !== undefined && field.requiredOnly !== context.side)
    return `${jsdoc(field.annotations)}${propertyKey(field.name)}${optional ? "?" : ""}: ${renderType(field.type, context)}`
  })
  if (index !== undefined)
    lines.push(`[key: string]: ${renderType(widenIndex(index, fields), context)}`)
  return block(lines, multiline)
}

/** Lines as an object type body: inline when short and undocumented. */
export function block(lines: string[], multiline = false): string {
  if (lines.length === 0) return "{}"
  const inline = `{ ${lines.join("; ")} }`
  if (!multiline && inline.length <= MAX_INLINE_OBJECT && !inline.includes("\n")) return inline
  return `{\n  ${lines.map((line) => indentTail(line, "  ")).join("\n  ")}\n}`
}

function render(type: Type, context: TypeContext): Rendered {
  switch (type.kind) {
    case "unknown":
    case "never":
    case "undefined":
    case "null":
    case "boolean":
    case "string":
    case "number":
      return atom(type.kind)
    case "binary":
      return atom(context.blob)
    case "literal":
      return atom(renderLiteral(type.value))
    case "ref": {
      const name =
        context.side === "request" ? (type.target.inputName ?? type.target.name) : type.target.name
      return atom(`${context.refPrefix}${name}`)
    }
    case "array":
      return atom(`${postfix(render(type.items, context))}[]`)
    case "tuple": {
      // TypeScript defers a tuple with an element that names a type alias.
      // Otherwise it resolves the tuple at once, also arrays and tuples inside
      // an unlabelled optional or rest element, so an alias named in them may
      // lead back circularly (TS2456); labelled, those are deferred.
      const elements = type.rest ? [...type.items, type.rest] : type.items
      const later = elements.filter((_, i) => i >= type.required)
      const labelled =
        !elements.some((t) => namesAlias(t)) && later.some((t) => aliasInList(t, false))
      const items = type.items.map((item, i) => {
        const text = render(item, context)
        const optional = i >= type.required
        if (labelled) return `_${i}${optional ? "?" : ""}: ${text.text}`
        return optional ? `${postfix(text)}?` : text.text
      })
      if (type.rest) {
        const rest = `${postfix(render(type.rest, context))}[]`
        items.push(labelled ? `...rest: ${rest}` : `...${rest}`)
      }
      return atom(`[${items.join(", ")}]`)
    }
    case "object":
      return atom(renderFields(type.fields, indexOf(type), context))
    case "union": {
      // Distinct types can render alike (fields required on the other side only).
      const texts = new Set(
        type.members.map((m) => {
          const r = render(m, context)
          return r.precedence === Precedence.Intersection ? `(${r.text})` : r.text
        }),
      )
      if (texts.size === 1) return render(type.members[0], context)
      return { text: [...texts].join(" | "), precedence: Precedence.Union }
    }
    case "intersection":
      return {
        text:
          type.members
            .filter((m) => m.kind !== "unknown")
            .map((m) => {
              const r = render(m, context)
              return r.precedence === Precedence.Union ? `(${r.text})` : r.text
            })
            .join(" & ") || "unknown",
        precedence: Precedence.Intersection,
      }
    case "narrow":
      // Applied while building the model; never present when rendering.
      return render(type.type, context)
  }
}

/** A TypeScript index signature must admit every property's type. */
function widenIndex(index: Type, fields: Field[]): Type {
  if (index.kind === "unknown") return index
  const members = [index, ...fields.map((f) => f.type)]
  if (fields.some((f) => !f.required || f.requiredOnly !== undefined)) members.push(UNDEFINED)
  return union(members)
}

/**
 * Whether a type names a type alias that may lead back (a declaration that is not an interface), or
 * unites some.
 */
function namesAlias(type: Type): boolean {
  switch (type.kind) {
    case "ref":
      return type.target.type.kind !== "object"
    case "union":
    case "intersection":
      return type.members.some((m) => namesAlias(m))
    default:
      return false
  }
}

/** Whether a type names a type alias inside array or tuple syntax (`inList` once inside). */
function aliasInList(type: Type, inList: boolean): boolean {
  switch (type.kind) {
    case "union":
    case "intersection":
      return type.members.some((m) => aliasInList(m, inList))
    case "array":
      return aliasInList(type.items, true)
    case "tuple":
      return [...type.items, ...(type.rest ? [type.rest] : [])].some((t) => aliasInList(t, true))
    default:
      return inList && namesAlias(type)
  }
}

function atom(text: string): Rendered {
  return { text, precedence: Precedence.Atom }
}

function postfix(rendered: Rendered): string {
  return rendered.precedence === Precedence.Atom ? rendered.text : `(${rendered.text})`
}

function renderLiteral(value: Literal): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value)
  if (typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map((v) => renderLiteral(v)).join(", ")}]`
  const entries = Object.entries(value).map(([k, v]) => `${propertyKey(k)}: ${renderLiteral(v)}`)
  return entries.length === 0 ? "{}" : `{ ${entries.join("; ")} }`
}
