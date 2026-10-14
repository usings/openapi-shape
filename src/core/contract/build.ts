import type { DocumentSet, Node } from "../openapi/documents"
import type { Diagnostics } from "../shared/diagnostics"
import { uniqueName } from "../shared/naming"
import { isRecord } from "../shared/object"
import { intersect, seal, union } from "./algebra"
import { applyNarrowing } from "./discriminator"
import type {
  Contract,
  Declaration,
  Field,
  Info,
  Operation,
  Runtime,
  SecurityScheme,
  Type,
} from "./model"
import { UNKNOWN, childTypes } from "./model"
import { buildOperations, implicitServers, requirements, serverUrls } from "./operations"
import { resolveObject } from "./references"
import { KNOWN_DIALECTS, SchemaBuilder } from "./schema"

/** Build the contract for an OpenAPI Description whose documents are (being) loaded. */
export function buildContract(docs: DocumentSet, diagnostics: Diagnostics): Contract {
  const builder = new SchemaBuilder(docs, diagnostics)
  const root = docs.root(docs.entry)
  const entry = isRecord(root.value) ? root.value : {}
  const dialect = entry.jsonSchemaDialect
  if (typeof dialect === "string" && !KNOWN_DIALECTS.some((known) => known.test(dialect))) {
    builder.warn(
      "unknown-dialect",
      `Unknown JSON Schema dialect "${dialect}"; schemas are read as JSON Schema 2020-12`,
      root,
      "jsonSchemaDialect",
    )
  }

  builder.declareComponents()
  builder.buildDeclarations()
  const operations = buildOperations(builder)
  builder.buildDeclarations()
  const all = [...operations.endpoints, ...operations.webhooks, ...operations.callbacks]

  // Every declaration is built: analysis may now look into referenced types.
  const report = (message: string, location: string): void =>
    diagnostics.warn("discriminator-mismatch", message, location)
  transformAll(builder.declarations, all, (type) =>
    type.kind === "narrow" ? applyNarrowing(type, report) : type,
  )
  breakDirectCycles(builder.declarations, (owner, target) => {
    const at = builder.stateOf(owner)?.node ?? root
    builder.warn(
      "circular-schema",
      `${owner.name} and ${target.name} are defined in terms of each other only through allOf/anyOf/oneOf/$ref, which never terminates; inside ${owner.name}, ${target.name} is expanded without the parts that lead back`,
      at,
    )
  })
  // With references final, simplify again: shapes behind references are known now.
  seal(builder.declarations)
  transformAll(builder.declarations, all, (type) => type)
  // What the client sends: endpoint requests, and the responses to webhooks and callbacks.
  const sent = [
    ...operations.endpoints.flatMap((op) => requestTypes(op)),
    ...[...operations.webhooks, ...operations.callbacks].flatMap((op) => responseTypes(op)),
  ]
  for (const declaration of assignInputNames(builder.declarations, sent)) {
    const at = builder.stateOf(declaration)?.node
    if (at && declaration.inputName !== `${declaration.name}Input`) {
      builder.warn(
        "renamed-schema",
        `The request-side variant of ${declaration.name} is emitted as ${declaration.inputName} because ${declaration.name}Input is already taken`,
        at,
      )
    }
  }

  return {
    info: readInfo(entry),
    ...operations,
    declarations: builder.declarations,
    runtime: readRuntime(builder, operations.endpoints),
  }
}

/** Servers, security schemes, and default security of the entry document. */
function readRuntime(builder: SchemaBuilder, endpoints: Operation[]): Runtime {
  const root = builder.docs.root(builder.docs.entry)
  const runtime: Runtime = {
    servers:
      serverUrls(builder, builder.docs.child(root, "servers")) ??
      implicitServers(builder.docs.entry),
    security: {},
  }
  const schemes = builder.docs.child(root, "components", "securitySchemes")
  if (isRecord(schemes.value)) {
    // Built from entries: a scheme may be named `__proto__`.
    runtime.security = Object.fromEntries(
      Object.keys(schemes.value).flatMap((name) => {
        const resolved = resolveObject(builder, builder.docs.child(schemes, name))
        const scheme = resolved && securityScheme(builder, resolved.node)
        return scheme ? [[name, scheme]] : []
      }),
    )
  }
  const requires = requirements(builder, builder.docs.child(root, "security"))
  if (requires) runtime.requires = requires
  const credentials = Object.values(runtime.security).some((s) => s.type !== "mutualTLS")
  if (credentials && !requires && endpoints.some((e) => !e.requires)) {
    builder.warn(
      "lenient-security",
      "Security schemes are declared, but neither the document nor some operations require any; the client sends the credentials it is given to those operations",
      schemes,
    )
  }
  return runtime
}

function securityScheme(builder: SchemaBuilder, node: Node): SecurityScheme | undefined {
  const value = node.value
  const invalid = (message: string): undefined => {
    builder.warn("invalid-security", `${message}; the scheme is left out`, node)
    return undefined
  }
  if (!isRecord(value)) return invalid("A security scheme must be an object")
  switch (value.type) {
    case "apiKey":
      if (typeof value.name !== "string") return invalid('An apiKey scheme needs a "name"')
      if (value.in !== "header" && value.in !== "query" && value.in !== "cookie") {
        return invalid('An apiKey scheme\'s "in" must be header, query, or cookie')
      }
      return { type: "apiKey", in: value.in, name: value.name }
    case "http":
      if (typeof value.scheme !== "string") return invalid('An http scheme needs a "scheme"')
      return { type: "http", scheme: value.scheme.toLowerCase() }
    case "oauth2":
    case "openIdConnect":
    case "mutualTLS":
      return { type: value.type }
    default:
      return invalid(`Unknown security scheme type ${JSON.stringify(value.type)}`)
  }
}

function readInfo(entry: Record<string, unknown>): Info {
  const info: Info = { openapi: String(entry.openapi) }
  const source = isRecord(entry.info) ? entry.info : {}
  for (const key of ["title", "version", "description"] as const) {
    const value = source[key]
    if (typeof value === "string" && value.trim() !== "") info[key] = value.trim()
  }
  return info
}

/**
 * Rebuild every type of the contract bottom-up, renormalizing unions and
 * intersections, and passing each node through `finish`.
 */
function transformAll(
  declarations: Declaration[],
  operations: Operation[],
  finish: (type: Type) => Type,
): void {
  const fields = (list: Field[]): Field[] =>
    list.map((f) => ({ ...f, type: rebuild(f.type, finish) }))
  for (const declaration of declarations) declaration.type = rebuild(declaration.type, finish)
  for (const operation of operations) {
    operation.params = fields(operation.params)
    operation.query = fields(operation.query)
    operation.headers = fields(operation.headers)
    operation.cookies = fields(operation.cookies)
    if (operation.querystring) {
      operation.querystring.type = rebuild(operation.querystring.type, finish)
    }
    for (const media of operation.body?.content ?? []) media.type = rebuild(media.type, finish)
    for (const response of operation.responses) {
      response.type = rebuild(response.type, finish)
      response.headers = fields(response.headers)
    }
  }
}

function rebuild(type: Type, finish: (type: Type) => Type): Type {
  const again = (t: Type): Type => rebuild(t, finish)
  switch (type.kind) {
    case "object": {
      const out: Type = {
        ...type,
        fields: type.fields.map((f) => ({ ...f, type: again(f.type) })),
      }
      if (type.additional) out.additional = again(type.additional)
      if (type.patterns) out.patterns = type.patterns.map((p) => ({ ...p, type: again(p.type) }))
      return finish(out)
    }
    case "array":
      return finish({ ...type, items: again(type.items) })
    case "tuple": {
      const out: Type = { ...type, items: type.items.map(again) }
      if (type.rest) out.rest = again(type.rest)
      return finish(out)
    }
    case "union":
      return finish(union(type.members.map(again)))
    case "intersection":
      return finish(intersect(type.members.map(again)))
    case "narrow":
      return finish({ ...type, type: again(type.type) })
    default:
      return finish(type)
  }
}

/**
 * A type alias may refer to itself only through object properties or array
 * elements. References that reach back through unions and intersections
 * alone describe a schema that never terminates; such a reference is replaced
 * by the referenced type minus the parts that lead back, which is sound.
 */
function breakDirectCycles(
  declarations: Declaration[],
  report: (owner: Declaration, target: Declaration) => void,
): void {
  const state = new Map<Declaration, "active" | "done">()
  const visit = (declaration: Declaration): void => {
    state.set(declaration, "active")
    declaration.type = rewrite(declaration.type, declaration)
    state.set(declaration, "done")
  }
  const rewrite = (type: Type, owner: Declaration): Type => {
    switch (type.kind) {
      case "ref": {
        const status = state.get(type.target)
        if (status === "active") {
          report(owner, type.target)
          return rewrite(withoutActive(type.target.type), owner)
        }
        if (status === undefined) visit(type.target)
        return type
      }
      case "union":
        return union(type.members.map((m) => rewrite(m, owner)))
      case "intersection":
        return intersect(type.members.map((m) => rewrite(m, owner)))
      default:
        return type
    }
  }
  const withoutActive = (type: Type): Type => {
    switch (type.kind) {
      case "ref":
        return state.get(type.target) === "active" ? UNKNOWN : type
      case "union":
        return union(type.members.map(withoutActive))
      case "intersection":
        return intersect(type.members.map(withoutActive))
      default:
        return type
    }
  }
  for (const declaration of declarations) {
    if (!state.has(declaration)) visit(declaration)
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
  return op.responses.flatMap((r) => [r.type, ...r.headers.map((f) => f.type)])
}

/**
 * Give a request-side name to declarations whose required properties differ
 * between the two sides (readOnly/writeOnly), when something the client sends
 * (`sent`) uses them.
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
