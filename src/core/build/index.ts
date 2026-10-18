import type { DocumentSet } from "../load/documents"
import { intersect, seal, union } from "../model/algebra"
import type { Declaration, Field, Info, Model, Operation, Type } from "../model/types"
import { UNKNOWN, childTypes } from "../model/types"
import { Diagnostics } from "../shared/diagnostics"
import { uniqueName } from "../shared/naming"
import { isRecord } from "../shared/object"
import { BuildContext } from "./context"
import { applyNarrowing } from "./discriminators"
import type { Operations } from "./operations"
import { buildOperations } from "./operations"
import { SchemaBuilder } from "./schemas"

/**
 * Build the model of an OpenAPI Description. A build that reaches documents not loaded yet asks for
 * them; they are loaded and the build starts over, so that every build sees the same documents from
 * start to end.
 */
export async function buildModel(
  documents: DocumentSet,
): Promise<{ model: Model; diagnostics: Diagnostics }> {
  for (;;) {
    const diagnostics = new Diagnostics()
    const model = buildOnce(new BuildContext(documents, diagnostics))
    if (documents.hasPending) {
      // oxlint-disable-next-line no-await-in-loop -- each build needs the documents the previous one asked for
      if (await documents.loadPending()) continue
      diagnostics.error("unresolved-ref", "References nest too deeply across documents", "#")
    }
    return { model, diagnostics }
  }
}

function buildOnce(context: BuildContext): Model {
  const root = context.documents.root(context.documents.entry)
  const entry = isRecord(root.value) ? root.value : {}
  const schemas = new SchemaBuilder(context)
  schemas.declareComponents()
  schemas.buildDeclarations()
  const operations = buildOperations(context, schemas)
  // The schemas operations reference, named while building them.
  schemas.buildDeclarations()

  // Every declaration is built: analysis may now look into referenced types.
  applyDiscriminators(context, schemas, operations)
  breakDirectCycles(context, schemas)
  normalizeTypes(schemas, operations)
  assignInputVariants(context, schemas, operations)
  return { info: readInfo(entry), ...operations, declarations: schemas.declarations }
}

function allOperations(operations: Operations): Operation[] {
  return [...operations.endpoints, ...operations.webhooks, ...operations.callbacks]
}

/** Narrow discriminated alternatives by their values (see `discriminators`). */
function applyDiscriminators(
  context: BuildContext,
  schemas: SchemaBuilder,
  operations: Operations,
): void {
  const report = (message: string, location: string): void =>
    context.diagnostics.warn("discriminator-mismatch", message, location)
  transformAll(schemas.declarations, allOperations(operations), (type) =>
    type.kind === "narrow" ? applyNarrowing(type, report) : type,
  )
}

/** With references final, simplify every type again: shapes behind references are known now. */
function normalizeTypes(schemas: SchemaBuilder, operations: Operations): void {
  seal(schemas.declarations)
  transformAll(schemas.declarations, allOperations(operations), (type) => type)
}

/**
 * Name the request-side variants of declarations whose required properties differ by side, where
 * what the client sends uses them: endpoint requests, and the responses to webhooks and callbacks.
 */
function assignInputVariants(
  context: BuildContext,
  schemas: SchemaBuilder,
  operations: Operations,
): void {
  const sent = [
    ...operations.endpoints.flatMap((op) => requestTypes(op)),
    ...[...operations.webhooks, ...operations.callbacks].flatMap((op) => responseTypes(op)),
  ]
  for (const declaration of assignInputNames(schemas.declarations, sent)) {
    const at = schemas.stateOf(declaration)?.node
    if (at && declaration.inputName !== `${declaration.name}Input`) {
      context.warn(
        "renamed-schema",
        `The request-side variant of ${declaration.name} is emitted as ${declaration.inputName} because ${declaration.name}Input is already taken`,
        at,
      )
    }
  }
}

function readInfo(entry: Record<string, unknown>): Info {
  const servers = Array.isArray(entry.servers) ? entry.servers : []
  const info: Info = {
    openapi: String(entry.openapi),
    servers: servers.flatMap((s: unknown) =>
      isRecord(s) && typeof s.url === "string" ? [s.url] : [],
    ),
  }
  const source = isRecord(entry.info) ? entry.info : {}
  for (const key of ["title", "version", "description"] as const) {
    const value = source[key]
    if (typeof value === "string" && value.trim() !== "") info[key] = value.trim()
  }
  return info
}

/**
 * Rebuild every type of the contract bottom-up, renormalizing unions and intersections, and passing
 * each node through `finish`.
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
      for (const media of response.content) media.type = rebuild(media.type, finish)
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
 * A type alias may refer to itself only through object properties or array elements. References
 * that reach back through unions and intersections alone describe a schema that never terminates;
 * such a reference is replaced by the referenced type minus the parts that lead back, which is
 * sound.
 */
function breakDirectCycles(context: BuildContext, schemas: SchemaBuilder): void {
  const report = (owner: Declaration, target: Declaration): void => {
    const at = schemas.stateOf(owner)?.node ?? context.documents.root(context.documents.entry)
    context.warn(
      "circular-schema",
      `${owner.name} and ${target.name} are defined in terms of each other only through allOf/anyOf/oneOf/$ref, which never terminates; inside ${owner.name}, ${target.name} is expanded without the parts that lead back`,
      at,
    )
  }
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
  for (const declaration of schemas.declarations) {
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
