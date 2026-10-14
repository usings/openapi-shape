import type { DocumentSet, Node } from "../openapi/documents"
import type { Diagnostics } from "../shared/diagnostics"
import { classifyMediaType } from "../shared/media"
import { toIdentifier, uniqueName } from "../shared/naming"
import { isRecord } from "../shared/object"
import { appendPointer, parsePointer } from "../shared/pointer"
import {
  includesJson,
  intersect,
  isJsonValue,
  isOfType,
  literal,
  matchesPattern,
  union,
} from "./algebra"
import { narrowDiscriminated, parentDiscriminators } from "./discriminator"
import { schemaDocs } from "./docs"
import type { Declaration, Field, Type, View } from "./model"
import { NEVER, NULL, UNKNOWN } from "./model"
import { componentNameOf, identity } from "./nodes"

/** Keywords that change a schema's type. */
const TYPE_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "format",
  "nullable",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "items",
  "prefixItems",
  "additionalItems",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "discriminator",
  "readOnly",
  "writeOnly",
  "$ref",
  "$dynamicRef",
])

/** JSON Schema keywords the OpenAPI 3.0 Schema Object does not define, but documents use. */
const BEYOND_30 = [
  "const",
  "prefixItems",
  "patternProperties",
  "if",
  "then",
  "else",
  "additionalItems",
]

const OBJECT_KEYWORDS = ["properties", "patternProperties", "additionalProperties", "required"]
const ARRAY_KEYWORDS = ["items", "prefixItems"]

/**
 * Whether a schema describes raw bytes: a `format: binary` string, a string
 * of a binary `contentMediaType` without `contentEncoding`, or Swagger's `type: file`.
 */
export function describesRawBytes(node: Node): boolean {
  const schema = node.value
  if (!isRecord(schema)) return false
  if (schema.type === "file") return true
  const strings =
    schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"))
  if (!strings) return false
  if (schema.format === "binary") return true
  return (
    typeof schema.contentMediaType === "string" &&
    schema.contentEncoding === undefined &&
    classifyMediaType(schema.contentMediaType) === "binary"
  )
}

export const KNOWN_DIALECTS = [
  /^https:\/\/spec\.openapis\.org\/oas\/3\.[12]\/dialect\//,
  /^https:\/\/json-schema\.org\/draft\/(2020-12|2019-09)\/schema#?$/,
]

interface DeclarationState {
  decl: Declaration
  node: Node
  /** The component that lent its name, when `node` is the schema it aliases. */
  origin?: Node
  /** Component name, for discriminator implicit mapping. */
  componentName?: string
}

/**
 * Converts Schema Objects into contract types and owns the named declarations.
 *
 * Every entry-document component becomes a declaration. Other referenced
 * schemas become declarations when they look like definitions (another
 * document's components, `$defs`, whole schema documents, `$id` resources) or
 * when inlining them would recurse; all other references are inlined.
 *
 * Declarations are built one at a time from a queue: a reference only names
 * its target, so no type depends on the order declarations are built in.
 *
 * Every OpenAPI version is read with JSON Schema 2020-12 semantics. Where an
 * older document uses something its version does not define, or defines
 * differently, the document's evident intent wins and a `lenient-*` warning
 * says so: the types must work against the real API.
 */
export class SchemaBuilder {
  readonly declarations: Declaration[] = []
  private readonly byIdentity = new Map<string, DeclarationState>()
  private readonly states = new Map<Declaration, DeclarationState>()
  private readonly queue: DeclarationState[] = []
  private readonly taken = new Set<string>()
  private readonly inlining = new Set<string>()
  /** Referenced schemas inlined once, by identity: a second reference names them. */
  private readonly inlined = new Map<string, Type>()
  private readonly checkedDialects = new Set<string>()

  constructor(
    readonly docs: DocumentSet,
    readonly diagnostics: Diagnostics,
  ) {}

  /** Declare every `components.schemas` entry of the entry document, in order. */
  declareComponents(): void {
    const components = this.docs.child(this.docs.root(this.docs.entry), "components", "schemas")
    if (!isRecord(components.value)) return
    const states: DeclarationState[] = []
    for (const key of Object.keys(components.value)) {
      states.push(this.declare(this.docs.child(components, key), key, key))
    }
    // A component that only references another schema lends that schema its name.
    for (const state of states) {
      const target = this.aliasTarget(state.node)
      if (target && !this.byIdentity.has(identity(target))) {
        this.byIdentity.set(identity(target), state)
        state.origin = state.node
        state.node = target
      }
    }
  }

  /** Build every declared schema, including those declared while building. */
  buildDeclarations(): void {
    for (let state = this.queue.shift(); state !== undefined; state = this.queue.shift()) {
      let type = this.type(state.node)
      if (state.componentName !== undefined) {
        const selfIds = [identity(state.node)]
        if (state.origin) selfIds.push(identity(state.origin))
        type = parentDiscriminators(this, state.node, state.componentName, type, selfIds)
      }
      state.decl.type = type
      const docs = (state.origin && schemaDocs(state.origin)) ?? schemaDocs(state.node)
      if (docs) state.decl.docs = docs
    }
  }

  /** The contract type of a schema node. */
  type(node: Node): Type {
    const schema = node.value
    if (typeof schema === "boolean" && node.doc.version === "3.0") {
      this.warn("lenient-keyword", "OpenAPI 3.0 has no boolean schemas; applied anyway", node)
    }
    if (schema === undefined || schema === true) return UNKNOWN
    if (schema === false) return NEVER
    if (!isRecord(schema)) {
      this.warn("invalid-schema", "A schema must be an object or a boolean", node)
      return UNKNOWN
    }
    this.checkDialect(node, schema)
    const v30 = node.doc.version === "3.0"
    if (v30) this.lenient30(node, schema)

    const parts: Type[] = []
    if (typeof schema.$ref === "string") parts.push(this.ref(node, schema.$ref, "$ref"))
    if (typeof schema.$dynamicRef === "string") {
      this.warn(
        "dynamic-ref",
        "$dynamicRef is resolved statically, as if it were $ref",
        node,
        "$dynamicRef",
      )
      parts.push(this.ref(node, schema.$dynamicRef, "$dynamicRef"))
    }
    parts.push(this.structure(node, schema))
    const type = intersect(parts)
    if (schema.nullable !== true) return type
    this.nullable(node, schema)
    return union([type, NULL])
  }

  /** The declaration's source, for diagnostics and discriminators. */
  stateOf(declaration: Declaration): { node: Node; componentName?: string } | undefined {
    return this.states.get(declaration)
  }

  /** Follow `$ref`s that carry no other type keywords; `undefined` when `node` is not one. */
  aliasTarget(node: Node, seen = new Set<string>()): Node | undefined {
    const schema = node.value
    if (!isRecord(schema) || typeof schema.$ref !== "string") return undefined
    if (Object.keys(schema).some((k) => k !== "$ref" && TYPE_KEYWORDS.has(k))) return undefined
    const resolution = this.docs.resolve(schema.$ref, node)
    if (resolution.kind !== "found") return undefined
    const id = identity(resolution.node)
    if (seen.has(id)) return undefined
    seen.add(id)
    return this.aliasTarget(resolution.node, seen) ?? resolution.node
  }

  warn(code: Parameters<Diagnostics["warn"]>[0], message: string, node: Node, key?: string): void {
    const pointer = key === undefined ? node.pointer : appendPointer(node.pointer, key)
    this.diagnostics.warn(code, message, this.docs.locate(node.doc, pointer))
  }

  /** Where a 3.0 document goes beyond 3.0, follow it and say so. */
  private lenient30(node: Node, schema: Record<string, unknown>): void {
    if (typeof schema.$ref === "string") {
      const applied = Object.keys(schema).filter(
        (k) => k !== "$ref" && k !== "nullable" && TYPE_KEYWORDS.has(k),
      )
      if (applied.length > 0) {
        this.warn(
          "lenient-ref-siblings",
          `OpenAPI 3.0 ignores keywords next to $ref; ${applied.join(", ")} applied anyway`,
          node,
        )
      }
    }
    for (const keyword of BEYOND_30) {
      if (keyword in schema) {
        this.warn(
          "lenient-keyword",
          `"${keyword}" is not part of the OpenAPI 3.0 Schema Object; applied anyway`,
          node,
          keyword,
        )
      }
    }
    const beyond = (key: string, message: string): void =>
      this.warn("lenient-keyword", `${message}; applied anyway`, node, key)
    if (Array.isArray(schema.type)) beyond("type", 'OpenAPI 3.0 "type" must be a single string')
    if (schema.type === "null")
      beyond("type", 'OpenAPI 3.0 has no "null" type (it uses "nullable")')
    if (Array.isArray(schema.items) || typeof schema.items === "boolean") {
      beyond("items", 'OpenAPI 3.0 "items" must be a schema')
    }
  }

  /**
   * `nullable: true` admits null. OpenAPI 3.0.3+ limits it to a sibling
   * `type` that `enum`, `allOf`, or `$ref` do not override, and 3.1 removed
   * it; documents use it to mean "also null" either way.
   */
  private nullable(node: Node, schema: Record<string, unknown>): void {
    if (node.doc.version !== "3.0") {
      this.warn(
        "lenient-nullable",
        '"nullable" was removed in OpenAPI 3.1 (use type: [..., "null"]); null is allowed anyway',
        node,
        "nullable",
      )
      return
    }
    // Where the strict reading would still admit null, there is nothing to report.
    const overriding =
      (Array.isArray(schema.enum) && !schema.enum.includes(null)) ||
      ["$ref", "allOf", "anyOf", "oneOf"].some((k) => k in schema)
    const strictExcludesNull =
      typeof schema.type === "string" ? overriding : overriding || "const" in schema
    if (strictExcludesNull) {
      this.warn(
        "lenient-nullable",
        '"nullable: true" only takes effect through a sibling "type" that no enum, allOf, anyOf, oneOf, or $ref overrides (OpenAPI 3.0.3+); null is allowed anyway',
        node,
        "nullable",
      )
    }
  }

  /** Everything except references: value keywords, applicators, discriminators. */
  private structure(node: Node, schema: Record<string, unknown>): Type {
    // `not` is otherwise unrepresentable; ignoring it keeps the type sound (wider).
    if (schema.not === true || (isRecord(schema.not) && Object.keys(schema.not).length === 0)) {
      return NEVER
    }
    const parts: Type[] = [this.valueType(node, schema)]
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = schema[keyword]
      if (!Array.isArray(branches)) continue
      if (branches.length === 0) {
        this.warn("invalid-schema", `"${keyword}" must not be empty`, node, keyword)
      }
      const types = branches.map((_, i) => this.type(this.docs.child(node, keyword, i)))
      if (keyword === "allOf") parts.push(...types)
      else parts.push(union(narrowDiscriminated(this, node, keyword, types)))
    }
    parts.push(this.conditional(node, schema))
    // A property one allOf member declares readOnly or writeOnly, and another
    // requires, is required on one side only.
    const sides = Array.isArray(schema.allOf) ? this.memberSides(node) : new Map<string, View>()
    return intersect(
      sides.size === 0 ? parts : parts.map((part) => this.withSides(node, part, sides)),
    )
  }

  /** The side readOnly/writeOnly properties of the allOf members apply to, by name. */
  private memberSides(node: Node): Map<string, View> {
    const sides = new Map<string, View>()
    const seen = new Set<string>()
    const visit = (member: Node): void => {
      const target = this.aliasTarget(member) ?? member
      const schema = target.value
      if (!isRecord(schema) || seen.has(identity(target))) return
      seen.add(identity(target))
      if (isRecord(schema.properties)) {
        for (const name of Object.keys(schema.properties)) {
          const property = this.docs.child(target, "properties", name)
          if (this.flag(property, "readOnly")) sides.set(name, "response")
          else if (this.flag(property, "writeOnly")) sides.set(name, "request")
        }
      }
      if (Array.isArray(schema.allOf)) {
        schema.allOf.forEach((_, i) => visit(this.docs.child(target, "allOf", i)))
      }
    }
    visit(node)
    return sides
  }

  private withSides(node: Node, type: Type, sides: Map<string, View>): Type {
    if (type.kind !== "object") return type
    const fields = type.fields.map((field) => {
      const side = sides.get(field.name)
      if (!field.required || field.requiredOnly !== undefined || side === undefined) return field
      this.oneSided(node, "required")
      return { ...field, requiredOnly: side }
    })
    return { ...type, fields }
  }

  /** In 3.1+, readOnly/writeOnly are annotations; requiring a property on one side only follows 3.0. */
  private oneSided(node: Node, key: string): void {
    if (node.doc.version === "3.0") return
    this.warn(
      "lenient-read-only",
      "A required readOnly/writeOnly property is required on one side only, as in OpenAPI 3.0; OpenAPI 3.1+ treats readOnly and writeOnly as annotations",
      node,
      key,
    )
  }

  /** `if`/`then`/`else` as the sound union `(if & then) | else` (the negation of `if` is not expressible). */
  private conditional(node: Node, schema: Record<string, unknown>): Type {
    if (!("if" in schema) || !("else" in schema)) return UNKNOWN
    const condition = this.type(this.docs.child(node, "if"))
    const otherwise = this.type(this.docs.child(node, "else"))
    if (!("then" in schema)) return union([condition, otherwise])
    return union([intersect([condition, this.type(this.docs.child(node, "then"))]), otherwise])
  }

  /** `type`, `const`, `enum`, and the type-specific keywords. */
  private valueType(node: Node, schema: Record<string, unknown>): Type {
    let types: string[] | undefined
    if (typeof schema.type === "string") types = [schema.type]
    else if (Array.isArray(schema.type)) {
      types = schema.type.filter((t): t is string => typeof t === "string")
    }

    let values: unknown[] | undefined
    if ("const" in schema) values = [schema.const]
    if (Array.isArray(schema.enum)) {
      values =
        values === undefined
          ? schema.enum
          : values.filter((v) => includesJson(schema.enum as unknown[], v))
    }
    if (values !== undefined) {
      const keyword = Array.isArray(schema.enum) ? "enum" : "const"
      if (!values.every((v) => isJsonValue(v))) {
        this.warn("invalid-schema", `"${keyword}" contains values that are not JSON`, node, keyword)
      }
      return union(
        values
          .filter(
            (v) => isJsonValue(v) && (types === undefined || types.some((t) => isOfType(v, t))),
          )
          .map((v) => literal(v)),
      )
    }
    if (types !== undefined) return union(types.map((t) => this.ofType(node, schema, t)))

    // No `type`: shape keywords imply the shape they constrain (see `inferred`).
    const implied: Type[] = []
    if (OBJECT_KEYWORDS.some((k) => k in schema)) implied.push(this.objectType(node, schema, true))
    if (ARRAY_KEYWORDS.some((k) => k in schema)) implied.push(this.arrayType(node, schema, true))
    if (implied.length === 0) return UNKNOWN
    return union(implied)
  }

  private ofType(node: Node, schema: Record<string, unknown>, type: string): Type {
    const format = typeof schema.format === "string" ? schema.format : undefined
    switch (type) {
      case "null":
        return NULL
      case "boolean":
        return { kind: "boolean" }
      case "integer":
      case "number":
        return format === undefined ? { kind: "number" } : { kind: "number", format }
      case "string":
        // Raw bytes, as files are declared: a Blob (3.0 defines `format: binary`
        // so; 3.1+ reads such a string as text).
        if (describesRawBytes(node)) {
          const by = schema.format === "binary" ? "format" : "contentMediaType"
          if (node.doc.version !== "3.0") {
            this.warn(
              "lenient-format",
              'A string is text in OpenAPI 3.1+ (raw bytes have no "type"); it is read as raw bytes, as its format or media type intends',
              node,
              by,
            )
          } else if (by === "contentMediaType") {
            this.warn(
              "lenient-keyword",
              '"contentMediaType" is not part of the OpenAPI 3.0 Schema Object; applied anyway, as raw bytes',
              node,
              by,
            )
          }
          return { kind: "binary" }
        }
        return format === undefined ? { kind: "string" } : { kind: "string", format }
      case "file":
        this.warn(
          "lenient-format",
          '"type: file" is Swagger 2.0, not OpenAPI 3.x; read as raw bytes',
          node,
          "type",
        )
        return { kind: "binary" }
      case "array":
        return this.arrayType(node, schema, false)
      case "object":
        return this.objectType(node, schema, false)
      default:
        this.warn("invalid-schema", `Unknown type "${type}"`, node, "type")
        return UNKNOWN
    }
  }

  private arrayType(node: Node, schema: Record<string, unknown>, inferred: boolean): Type {
    const flag = inferred ? ({ inferred: true } as const) : {}
    // Tuple form: `items` array (drafts before 2020-12) or `prefixItems` (2020-12).
    let prefixKey: "items" | "prefixItems" | undefined
    let restKey: "additionalItems" | "items" = "items"
    if (Array.isArray(schema.items)) {
      prefixKey = "items"
      restKey = "additionalItems"
    } else if (Array.isArray(schema.prefixItems)) {
      prefixKey = "prefixItems"
    }
    if (prefixKey === undefined) {
      if (schema.items === false) return { kind: "tuple", items: [], required: 0, ...flag }
      const items = "items" in schema ? this.type(this.docs.child(node, "items")) : UNKNOWN
      return { kind: "array", items, ...flag }
    }
    const prefix = (schema[prefixKey] as unknown[]).map((_, i) =>
      this.type(this.docs.child(node, prefixKey, i)),
    )
    const minItems = typeof schema.minItems === "number" ? schema.minItems : 0
    const required = Math.min(Math.max(0, Math.floor(minItems)), prefix.length)
    const restSchema = schema[restKey]
    if (restSchema === false) return { kind: "tuple", items: prefix, required, ...flag }
    const rest = restSchema === undefined ? UNKNOWN : this.type(this.docs.child(node, restKey))
    return { kind: "tuple", items: prefix, required, rest, ...flag }
  }

  private objectType(node: Node, schema: Record<string, unknown>, inferred: boolean): Type {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((r): r is string => typeof r === "string")
        : [],
    )
    const fields: Field[] = []
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const name of Object.keys(properties)) {
      const child = this.docs.child(node, "properties", name)
      const field: Field = { name, type: this.type(child), required: required.has(name) }
      // A required readOnly property is required in responses only, writeOnly in requests only.
      if (field.required) {
        if (this.flag(child, "readOnly")) field.requiredOnly = "response"
        else if (this.flag(child, "writeOnly")) field.requiredOnly = "request"
        if (field.requiredOnly) this.oneSided(node, "required")
      }
      const docs = schemaDocs(child)
      if (docs) field.docs = docs
      fields.push(field)
    }

    const patterns: Array<{ pattern: string; type: Type }> = []
    if (isRecord(schema.patternProperties)) {
      for (const pattern of Object.keys(schema.patternProperties)) {
        patterns.push({
          pattern,
          type: this.type(this.docs.child(node, "patternProperties", pattern)),
        })
      }
    }
    const additional = schema.additionalProperties
    let additionalType: Type | undefined
    if (additional === true) additionalType = UNKNOWN
    else if (isRecord(additional)) {
      additionalType = this.type(this.docs.child(node, "additionalProperties"))
    }

    // A required property without a declaration still exists, typed by the
    // patternProperties or additionalProperties that apply to it.
    for (const name of required) {
      if (Object.hasOwn(properties, name)) continue
      const matches = patterns.map((p) => matchesPattern(p.pattern, name))
      let type: Type
      // A pattern JavaScript cannot evaluate might match: stay wide.
      if (matches.includes(undefined)) type = UNKNOWN
      else if (matches.includes(true))
        type = intersect(patterns.filter((_, i) => matches[i]).map((p) => p.type))
      else if (additional === false) type = NEVER
      else type = additionalType ?? UNKNOWN
      fields.push({ name, type, required: true })
    }

    const out: Type = { kind: "object", fields }
    if (additionalType) out.additional = additionalType
    if (patterns.length > 0) out.patterns = patterns
    if (inferred) out.inferred = true
    return out
  }

  /** Whether a boolean annotation holds: set on the schema, a schema it references, or an allOf member. */
  private flag(node: Node, keyword: "readOnly" | "writeOnly", seen = new Set<string>()): boolean {
    const schema = node.value
    if (!isRecord(schema) || seen.has(identity(node))) return false
    seen.add(identity(node))
    if (schema[keyword] === true) return true
    if (typeof schema.$ref === "string") {
      const resolution = this.docs.resolve(schema.$ref, node)
      if (resolution.kind === "found" && this.flag(resolution.node, keyword, seen)) return true
    }
    return (
      Array.isArray(schema.allOf) &&
      schema.allOf.some((_, i) => this.flag(this.docs.child(node, "allOf", i), keyword, seen))
    )
  }

  private checkDialect(node: Node, schema: Record<string, unknown>): void {
    const dialect = schema.$schema
    if (typeof dialect !== "string" || this.checkedDialects.has(dialect)) return
    this.checkedDialects.add(dialect)
    if (!KNOWN_DIALECTS.some((known) => known.test(dialect))) {
      this.warn(
        "unknown-dialect",
        `Unknown JSON Schema dialect "${dialect}"; the schema is read as JSON Schema 2020-12`,
        node,
        "$schema",
      )
    }
  }

  private ref(node: Node, ref: string, keyword: string): Type {
    const resolution = this.docs.resolve(ref, node)
    if (resolution.kind === "pending") return UNKNOWN
    if (resolution.kind === "error") {
      this.diagnostics.error(
        "unresolved-ref",
        `Cannot resolve ${keyword} "${ref}": ${resolution.message}`,
        this.docs.locate(node.doc, appendPointer(node.pointer, keyword)),
      )
      return UNKNOWN
    }
    return this.refTo(resolution.node)
  }

  private refTo(target: Node): Type {
    const id = identity(target)
    const existing = this.byIdentity.get(id)
    if (existing) return { kind: "ref", target: existing.decl }
    const definition = definitionName(target)
    if (definition !== undefined) {
      const state = this.declare(target, definition, componentNameOf(target))
      return { kind: "ref", target: state.decl }
    }
    if (this.inlining.has(id)) {
      // Recursion through an inline schema: give it a name so it can refer to itself.
      const state = this.declare(target, inlineName(target))
      this.queue.splice(this.queue.indexOf(state), 1)
      return { kind: "ref", target: state.decl }
    }
    // A schema referenced again is named, so that output grows with the input
    // rather than with the number of paths through it.
    const inlined = this.inlined.get(id)
    if (inlined !== undefined) {
      const state = this.declare(target, inlineName(target))
      this.queue.splice(this.queue.indexOf(state), 1)
      state.decl.type = inlined
      return { kind: "ref", target: state.decl }
    }
    this.inlining.add(id)
    const type = this.type(target)
    this.inlining.delete(id)
    const promoted = this.byIdentity.get(id)
    if (promoted === undefined) {
      this.inlined.set(id, type)
      return type
    }
    promoted.decl.type = type
    return { kind: "ref", target: promoted.decl }
  }

  private declare(node: Node, name: string, componentName?: string): DeclarationState {
    const base = toIdentifier(name)
    const unique = uniqueName(base, this.taken)
    if (unique !== base) {
      this.warn(
        "renamed-schema",
        `Schema "${name}" is emitted as ${unique} because ${base} is already taken`,
        node,
      )
    }
    this.taken.add(unique)
    const decl: Declaration = { name: unique, type: UNKNOWN }
    const state: DeclarationState = { decl, node, componentName }
    this.byIdentity.set(identity(node), state)
    this.states.set(decl, state)
    this.declarations.push(decl)
    this.queue.push(state)
    return state
  }
}

function definitionName(node: Node): string | undefined {
  const component = componentNameOf(node)
  if (component !== undefined) return component
  const tokens = parsePointer(node.pointer) ?? []
  const parent = tokens.at(-2)
  if (parent === "$defs" || parent === "definitions") return tokens.at(-1)
  if (tokens.length === 0 || (isRecord(node.value) && "$id" in node.value)) {
    const path = new URL(node.base).pathname
    const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "")
    return file === "" ? "Schema" : decodeLoosely(file)
  }
  return undefined
}

/** Percent-decoded where valid; a malformed escape stays as written. */
function decodeLoosely(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const STRUCTURAL_TOKENS = new Set([
  "components",
  "schemas",
  "properties",
  "items",
  "prefixItems",
  "additionalProperties",
  "patternProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "schema",
  "content",
  "paths",
  "responses",
  "requestBody",
  "parameters",
])

function inlineName(node: Node): string {
  const tokens = (parsePointer(node.pointer) ?? []).filter(
    (t) => !STRUCTURAL_TOKENS.has(t) && !/^\d+$/.test(t),
  )
  return tokens.slice(-3).join("_") || "Schema"
}
