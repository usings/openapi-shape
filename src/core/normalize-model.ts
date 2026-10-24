import type { BuildContext } from "./build-context"
import { applyNarrowing } from "./discriminators"
import type { Declaration, Field, Operation, Type } from "./model"
import { UNKNOWN, TYPE_LOCATION } from "./model"
import type { Operations } from "./operations"
import type { SchemaBuilder } from "./schemas"
import { union } from "./type-algebra"

/** Finalize model types once all referenced declarations have been built. */
export async function normalizeModel(
  schemas: SchemaBuilder,
  operations: Operations,
): Promise<void> {
  const context = schemas.context
  await applyDiscriminators(context, schemas, operations)
  await context.documents.reader.checkpoint()
  breakDirectCycles(context, schemas)
  await context.documents.reader.checkpoint()
  await normalizeTypes(schemas, operations)
  await context.documents.reader.checkpoint()
}

function allOperations(operations: Operations): Operation[] {
  return [...operations.endpoints, ...operations.webhooks, ...operations.callbacks]
}

/** Narrow discriminated alternatives by their values (see `discriminators`). */
async function applyDiscriminators(
  context: BuildContext,
  schemas: SchemaBuilder,
  operations: Operations,
): Promise<void> {
  const report = (message: string, location: string): void =>
    context.diagnostics.warn("discriminator-mismatch", message, location)
  await transformAll(schemas, allOperations(operations), (type) =>
    type.kind === "narrow" ? applyNarrowing(type, report) : type,
  )
}

/** With references final, simplify every type again: shapes behind references are known now. */
async function normalizeTypes(schemas: SchemaBuilder, operations: Operations): Promise<void> {
  for (const declaration of schemas.declarations) declaration.complete = true
  await transformAll(schemas, allOperations(operations), (type) => type)
}

/**
 * Rebuild every type of the model bottom-up, renormalizing unions and intersections, and passing
 * each node through `finish`.
 */
async function transformAll(
  schemas: SchemaBuilder,
  operations: Operation[],
  finish: (type: Type) => Type,
): Promise<void> {
  const fields = (list: Field[]): Field[] =>
    list.map((f) => ({ ...f, type: rebuild(f.type, finish, schemas, f.location) }))
  for (const declaration of schemas.declarations) {
    const source = schemas.stateOf(declaration)?.node
    const location = source && schemas.context.documents.locate(source.document, source.pointer)
    declaration.type = rebuild(declaration.type, finish, schemas, location)
    const pending = schemas.context.documents.reader.workpoint()
    // oxlint-disable-next-line no-await-in-loop -- yield between declarations, never inside algebra
    if (pending) await pending
  }
  for (const operation of operations) {
    operation.params = fields(operation.params)
    operation.query = fields(operation.query)
    operation.headers = fields(operation.headers)
    operation.cookies = fields(operation.cookies)
    if (operation.querystring) {
      operation.querystring.type = rebuild(
        operation.querystring.type,
        finish,
        schemas,
        operation.querystring.location,
      )
    }
    for (const media of operation.body?.content ?? [])
      media.type = rebuild(media.type, finish, schemas, media.location)
    for (const response of operation.responses) {
      for (const media of response.content)
        media.type = rebuild(media.type, finish, schemas, media.location)
      response.headers = fields(response.headers)
    }
    const pending = schemas.context.documents.reader.workpoint()
    // oxlint-disable-next-line no-await-in-loop -- yield between complete operations
    if (pending) await pending
  }
}

function rebuild(
  type: Type,
  finish: (type: Type) => Type,
  schemas: SchemaBuilder,
  location?: string,
): Type {
  const again = (t: Type): Type => rebuild(t, finish, schemas, location)
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
      return finish(schemas.intersect(type.members.map(again), type[TYPE_LOCATION] ?? location))
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
        return schemas.intersect(
          type.members.map((m) => rewrite(m, owner)),
          type[TYPE_LOCATION],
        )
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
        return schemas.intersect(type.members.map(withoutActive), type[TYPE_LOCATION])
      default:
        return type
    }
  }
  for (const declaration of schemas.declarations) {
    if (!state.has(declaration)) visit(declaration)
  }
}
