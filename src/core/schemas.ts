import { schemaAnnotations } from "./annotations"
import type { BuildContext } from "./build-context"
import { narrowDiscriminated, parentDiscriminators } from "./discriminators"
import { componentNameOf, identity } from "./document-nodes"
import type { DocumentNode } from "./documents"
import { parsePointer } from "./json-pointer"
import type { Declaration, Field, Type } from "./model"
import { NEVER, NULL, UNKNOWN } from "./model"
import { toIdentifier, uniqueName } from "./naming"
import { isRecord } from "./object"
import { matchesPattern } from "./patterns"
import { referencesOf } from "./references"
import { aliasReference, describesRawBytes } from "./schema-rules"
import { includesJson, intersect, isJsonValue, isOfType, literal, union } from "./type-algebra"

const OBJECT_KEYWORDS = ["properties", "patternProperties", "additionalProperties", "required"]
const ARRAY_KEYWORDS = ["items", "prefixItems"]

interface DeclarationState {
  decl: Declaration
  node: DocumentNode
  /** The component that lent its name, when `node` is the schema it aliases. */
  origin?: DocumentNode
  /** Component name, for discriminator implicit mapping. */
  componentName?: string
}

/**
 * Converts Schema Objects into model types and owns the named declarations.
 *
 * Every entry-document component becomes a declaration. Other referenced schemas become
 * declarations when they look like definitions (another document's components, `$defs`, whole
 * schema documents, `$id` resources) or when inlining them would recurse; all other references are
 * inlined.
 *
 * Declarations are built one at a time from a queue: a reference only names its target, so no type
 * depends on the order declarations are built in.
 *
 * Every OpenAPI version is read with JSON Schema 2020-12 semantics. Where an older document uses
 * something its version does not define, or defines differently, the document's evident intent
 * wins, as docs/openapi.md describes: the types must work against the real API.
 */
export class SchemaBuilder {
  readonly declarations: Declaration[] = []
  private readonly byIdentity = new Map<string, DeclarationState>()
  private readonly states = new Map<Declaration, DeclarationState>()
  private readonly queue: DeclarationState[] = []
  private readonly taken = new Set<string>()
  private readonly inlining = new Set<string>()
  /** Inline types are memoized after declaration planning, so later uses keep the same shape. */
  private readonly inlined = new Map<string, Type>()

  constructor(
    readonly context: BuildContext,
    private readonly repeated = new Set<string>(),
  ) {}

  /** Declare every `components.schemas` entry of the entry document, in order. */
  declareComponents(): void {
    const components = this.context.documents.child(
      this.context.documents.root(this.context.documents.entry),
      "components",
      "schemas",
    )
    if (!isRecord(components.value)) return
    const states: DeclarationState[] = []
    for (const key of Object.keys(components.value)) {
      states.push(this.declare(this.context.documents.child(components, key), key, key))
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
  async buildDeclarations(): Promise<void> {
    for (let state = this.queue.shift(); state !== undefined; state = this.queue.shift()) {
      let type = this.type(state.node)
      if (state.componentName !== undefined) {
        const selfIds = [identity(state.node)]
        if (state.origin) selfIds.push(identity(state.origin))
        type = parentDiscriminators(this, state.node, state.componentName, type, selfIds)
      }
      state.decl.type = type
      state.decl.location = this.context.documents.locate(state.node.document, state.node.pointer)
      const annotations =
        (state.origin && schemaAnnotations(state.origin)) ?? schemaAnnotations(state.node)
      if (annotations) state.decl.annotations = annotations
      const pending = this.context.documents.reader.workpoint()
      // oxlint-disable-next-line no-await-in-loop -- declarations are built in queue order
      if (pending) await pending
    }
  }

  /** The model type of a schema node. */
  type(node: DocumentNode): Type {
    const schema = node.value
    if (schema === undefined || schema === true) return UNKNOWN
    if (schema === false) return NEVER
    if (!isRecord(schema)) {
      this.context.warn("invalid-schema", "A schema must be an object or a boolean", node)
      return UNKNOWN
    }

    const parts = referencesOf(schema).map(([keyword, ref]) => this.ref(node, ref, keyword))
    parts.push(this.structure(node, schema))
    const type = this.intersect(parts, node)
    // `nullable: true` admits null wherever it appears, as documents mean it.
    return schema.nullable === true ? union([type, NULL]) : type
  }

  /** Normalize an intersection, retaining its source for analysis after references are built. */
  intersect(members: Type[], at?: DocumentNode | string): Type {
    const location =
      typeof at === "string" ? at : at && this.context.documents.locate(at.document, at.pointer)
    return intersect(members, {
      location,
      onWiden: (source, reason) =>
        this.context.diagnostics.warn(
          "schema-precision-loss",
          reason ??
            "The intersection exceeds 10,000 union combinations; its largest unions are widened to keep TypeScript compilable. Split the schema into smaller alternatives to retain precision",
          source ?? "#",
        ),
    })
  }

  /** The declaration's source, for diagnostics and discriminators. */
  stateOf(declaration: Declaration): { node: DocumentNode; componentName?: string } | undefined {
    return this.states.get(declaration)
  }

  /** Follow references that carry no other type keywords; `undefined` when `node` is not one. */
  aliasTarget(node: DocumentNode, seen = new Set<string>()): DocumentNode | undefined {
    const reference = aliasReference(node)
    if (reference === undefined) return undefined
    const [, ref] = reference
    const resolution = this.context.documents.resolveSchema(ref, node)
    if (resolution.kind !== "found") return undefined
    const id = identity(resolution.node)
    if (seen.has(id)) return undefined
    seen.add(id)
    return this.aliasTarget(resolution.node, seen) ?? resolution.node
  }

  /** Everything except references: value keywords, applicators, discriminators. */
  private structure(node: DocumentNode, schema: Record<string, unknown>): Type {
    // `not` is otherwise unrepresentable; ignoring it keeps the type sound (wider).
    if (schema.not === true || (isRecord(schema.not) && Object.keys(schema.not).length === 0)) {
      return NEVER
    }
    const parts: Type[] = [this.valueType(node, schema)]
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = schema[keyword]
      if (!Array.isArray(branches)) continue
      if (branches.length === 0) {
        this.context.warn("invalid-schema", `"${keyword}" must not be empty`, node, keyword)
      }
      const types = branches.map((_, i) =>
        this.type(this.context.documents.child(node, keyword, i)),
      )
      if (keyword === "allOf") parts.push(...types)
      else parts.push(union(narrowDiscriminated(this, node, keyword, types)))
    }
    parts.push(this.conditional(node, schema))
    return this.intersect(parts, node)
  }

  /**
   * `if`/`then`/`else` as the sound union `(if & then) | else` (the negation of `if` is not
   * expressible).
   */
  private conditional(node: DocumentNode, schema: Record<string, unknown>): Type {
    if (!("if" in schema) || !("else" in schema)) return UNKNOWN
    const condition = this.type(this.context.documents.child(node, "if"))
    const otherwise = this.type(this.context.documents.child(node, "else"))
    if (!("then" in schema)) return union([condition, otherwise])
    return union([
      this.intersect([condition, this.type(this.context.documents.child(node, "then"))], node),
      otherwise,
    ])
  }

  /** `type`, `const`, `enum`, and the type-specific keywords. */
  private valueType(node: DocumentNode, schema: Record<string, unknown>): Type {
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
        this.context.warn(
          "invalid-schema",
          `"${keyword}" contains values that are not JSON`,
          node,
          keyword,
        )
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

  private ofType(node: DocumentNode, schema: Record<string, unknown>, type: string): Type {
    switch (type) {
      case "null":
        return NULL
      case "boolean":
        return { kind: "boolean" }
      case "integer":
      case "number":
        return { kind: "number" }
      case "string":
        // Raw bytes, as files are declared: a Blob (3.0 defines `format: binary`
        // so; 3.1+ reads such a string as text, but documents still mean a file).
        return describesRawBytes(node) ? { kind: "binary" } : { kind: "string" }
      case "file":
        // Swagger 2.0's file, still found in 3.x documents.
        return { kind: "binary" }
      case "array":
        return this.arrayType(node, schema, false)
      case "object":
        return this.objectType(node, schema, false)
      default:
        this.context.warn("invalid-schema", `Unknown type "${type}"`, node, "type")
        return UNKNOWN
    }
  }

  private arrayType(node: DocumentNode, schema: Record<string, unknown>, inferred: boolean): Type {
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
      const items =
        "items" in schema ? this.type(this.context.documents.child(node, "items")) : UNKNOWN
      return { kind: "array", items, ...flag }
    }
    const prefix = (schema[prefixKey] as unknown[]).map((_, i) =>
      this.type(this.context.documents.child(node, prefixKey, i)),
    )
    const minItems = typeof schema.minItems === "number" ? schema.minItems : 0
    const required = Math.min(Math.max(0, Math.floor(minItems)), prefix.length)
    const restSchema = schema[restKey]
    if (restSchema === false) return { kind: "tuple", items: prefix, required, ...flag }
    const rest =
      restSchema === undefined ? UNKNOWN : this.type(this.context.documents.child(node, restKey))
    return { kind: "tuple", items: prefix, required, rest, ...flag }
  }

  private objectType(node: DocumentNode, schema: Record<string, unknown>, inferred: boolean): Type {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((r): r is string => typeof r === "string")
        : [],
    )
    const fields: Field[] = []
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const name of Object.keys(properties)) {
      const child = this.context.documents.child(node, "properties", name)
      const field: Field = { name, type: this.type(child), required: required.has(name) }
      // A required readOnly property is required in responses only, writeOnly in requests only.
      if (this.flag(child, "readOnly")) field.direction = "response"
      else if (this.flag(child, "writeOnly")) field.direction = "request"
      if (field.required && field.direction !== "both") field.requiredOnly = field.direction
      const annotations = schemaAnnotations(child)
      if (annotations) field.annotations = annotations
      fields.push(field)
    }

    const patterns: Array<{ pattern: string; type: Type }> = []
    if (isRecord(schema.patternProperties)) {
      for (const pattern of Object.keys(schema.patternProperties)) {
        patterns.push({
          pattern,
          type: this.type(this.context.documents.child(node, "patternProperties", pattern)),
        })
      }
    }
    const additional = schema.additionalProperties
    let additionalType: Type | undefined
    if (additional === true) additionalType = UNKNOWN
    else if (isRecord(additional)) {
      additionalType = this.type(this.context.documents.child(node, "additionalProperties"))
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
        type = this.intersect(
          patterns.filter((_, i) => matches[i]).map((p) => p.type),
          node,
        )
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

  /**
   * Whether a boolean annotation holds: set on the schema, a schema it references, or an allOf
   * member.
   */
  private flag(
    node: DocumentNode,
    keyword: "readOnly" | "writeOnly",
    seen = new Set<string>(),
  ): boolean {
    const schema = node.value
    if (!isRecord(schema) || seen.has(identity(node))) return false
    seen.add(identity(node))
    if (schema[keyword] === true) return true
    for (const [, ref] of referencesOf(schema)) {
      const resolution = this.context.documents.resolveSchema(ref, node)
      if (resolution.kind === "found" && this.flag(resolution.node, keyword, seen)) return true
    }
    return (
      Array.isArray(schema.allOf) &&
      schema.allOf.some((_, i) =>
        this.flag(this.context.documents.child(node, "allOf", i), keyword, seen),
      )
    )
  }

  private ref(node: DocumentNode, ref: string, keyword: string): Type {
    const resolution = this.context.documents.resolveSchema(ref, node)
    if (resolution.kind === "pending") return UNKNOWN
    if (resolution.kind === "error") {
      this.context.error(
        "unresolved-ref",
        `Cannot resolve ${keyword} "${ref}": ${resolution.message}`,
        node,
        keyword,
      )
      return UNKNOWN
    }
    return this.refTo(resolution.node)
  }

  private refTo(target: DocumentNode): Type {
    const id = identity(target)
    const existing = this.byIdentity.get(id)
    if (existing) return { kind: "ref", target: existing.decl }
    const definition = definitionName(target)
    if (definition !== undefined) {
      const state = this.declare(target, definition, componentNameOf(target))
      return { kind: "ref", target: state.decl }
    }
    if (this.repeated.has(id)) {
      return { kind: "ref", target: this.declare(target, inlineName(target)).decl }
    }
    if (this.inlining.has(id)) {
      // Recursion through an inline schema: give it a name so it can refer to itself.
      const state = this.declare(target, inlineName(target))
      this.queue.splice(this.queue.indexOf(state), 1)
      return { kind: "ref", target: state.decl }
    }
    const inlined = this.inlined.get(id)
    if (inlined !== undefined) return inlined
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

  private declare(node: DocumentNode, name: string, componentName?: string): DeclarationState {
    const base = toIdentifier(name)
    const unique = uniqueName(base, this.taken)
    if (unique !== base) {
      this.context.warn(
        "renamed-schema",
        `Schema "${name}" is emitted as ${unique} because ${base} is already taken`,
        node,
      )
    }
    this.taken.add(unique)
    const decl: Declaration = {
      name: unique,
      type: UNKNOWN,
      location: this.context.documents.locate(node.document, node.pointer),
    }
    const state: DeclarationState = { decl, node, componentName }
    this.byIdentity.set(identity(node), state)
    this.states.set(decl, state)
    this.declarations.push(decl)
    this.queue.push(state)
    return state
  }
}

function definitionName(node: DocumentNode): string | undefined {
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

function inlineName(node: DocumentNode): string {
  const tokens = (parsePointer(node.pointer) ?? []).filter(
    (t) => !STRUCTURAL_TOKENS.has(t) && !/^\d+$/.test(t),
  )
  return tokens.slice(-3).join("_") || "Schema"
}
