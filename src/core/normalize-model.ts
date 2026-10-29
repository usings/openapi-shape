import type { Diagnostics } from "./diagnostics"
import { applyNarrowing } from "./discriminator-narrowing"
import type { GenerationControl } from "./generation-control"
import type { Field, OperationGroups, OperationModel, TypeDeclaration, TypeNode } from "./model"
import { TYPE_LOCATION, UNKNOWN } from "./model"
import { intersect, union } from "./type-algebra"

/** Finalize model types once all referenced declarations have been built. */
export async function normalizeModel(
  declarations: TypeDeclaration[],
  operations: OperationGroups,
  context: NormalizeContext,
): Promise<void> {
  await applyDiscriminators(context, declarations, operations)
  await context.control.checkpoint()
  breakDirectCycles(context, declarations)
  await context.control.checkpoint()
  await normalizeTypes(context, declarations, operations)
  await context.control.checkpoint()
}

function allOperations(operations: OperationGroups): OperationModel[] {
  return [...operations.operations, ...operations.webhooks, ...operations.callbacks]
}

/** Narrow discriminated alternatives by their values (see `discriminators`). */
async function applyDiscriminators(
  context: NormalizeContext,
  declarations: TypeDeclaration[],
  operations: OperationGroups,
): Promise<void> {
  const report = (message: string, location: string): void =>
    context.diagnostics.warn("discriminator-mismatch", message, location)
  await transformAll(context, declarations, allOperations(operations), (type) =>
    type.kind === "narrow" ? applyNarrowing(type, report) : type,
  )
}

/** With references final, simplify every type again: shapes behind references are known now. */
async function normalizeTypes(
  context: NormalizeContext,
  declarations: TypeDeclaration[],
  operations: OperationGroups,
): Promise<void> {
  for (const declaration of declarations) declaration.complete = true
  await transformAll(context, declarations, allOperations(operations), (type) => type)
}

/**
 * Rebuild every type of the model bottom-up, renormalizing unions and intersections, and passing
 * each node through `finish`.
 */
async function transformAll(
  context: NormalizeContext,
  declarations: TypeDeclaration[],
  operations: OperationModel[],
  finish: (type: TypeNode) => TypeNode,
): Promise<void> {
  const fields = (list: Field[]): Field[] =>
    list.map((f) => ({ ...f, type: rebuild(f.type, finish, context, f.location) }))
  for (const declaration of declarations) {
    const location = declaration.location
    declaration.type = rebuild(declaration.type, finish, context, location)
    const pending = context.control.workpoint()
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
        context,
        operation.querystring.location,
      )
    }
    for (const media of operation.body?.content ?? [])
      media.type = rebuild(media.type, finish, context, media.location)
    for (const response of operation.responses) {
      for (const media of response.content)
        media.type = rebuild(media.type, finish, context, media.location)
      response.headers = fields(response.headers)
    }
    const pending = context.control.workpoint()
    // oxlint-disable-next-line no-await-in-loop -- yield between complete operations
    if (pending) await pending
  }
}

function rebuild(
  type: TypeNode,
  finish: (type: TypeNode) => TypeNode,
  context: NormalizeContext,
  location?: string,
): TypeNode {
  const again = (t: TypeNode): TypeNode => rebuild(t, finish, context, location)
  switch (type.kind) {
    case "object": {
      const out: TypeNode = {
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
      const out: TypeNode = { ...type, items: type.items.map(again) }
      if (type.rest) out.rest = again(type.rest)
      return finish(out)
    }
    case "union":
      return finish(union(type.members.map(again)))
    case "intersection":
      return finish(intersection(context, type.members.map(again), type[TYPE_LOCATION] ?? location))
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
function breakDirectCycles(context: NormalizeContext, declarations: TypeDeclaration[]): void {
  const report = (owner: TypeDeclaration, target: TypeDeclaration): void => {
    context.diagnostics.warn(
      "circular-schema",
      `${owner.name} and ${target.name} are defined in terms of each other only through allOf/anyOf/oneOf/$ref, which never terminates; inside ${owner.name}, ${target.name} is expanded without the parts that lead back`,
      owner.location ?? "#",
    )
  }
  const state = new Map<TypeDeclaration, "active" | "done">()
  const visit = (declaration: TypeDeclaration): void => {
    state.set(declaration, "active")
    declaration.type = rewrite(declaration.type, declaration)
    state.set(declaration, "done")
  }
  const rewrite = (type: TypeNode, owner: TypeDeclaration): TypeNode => {
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
        return intersection(
          context,
          type.members.map((m) => rewrite(m, owner)),
          type[TYPE_LOCATION],
        )
      default:
        return type
    }
  }
  const withoutActive = (type: TypeNode): TypeNode => {
    switch (type.kind) {
      case "ref":
        return state.get(type.target) === "active" ? UNKNOWN : type
      case "union":
        return union(type.members.map(withoutActive))
      case "intersection":
        return intersection(context, type.members.map(withoutActive), type[TYPE_LOCATION])
      default:
        return type
    }
  }
  for (const declaration of declarations) {
    if (!state.has(declaration)) visit(declaration)
  }
}

interface NormalizeContext {
  diagnostics: Diagnostics
  control: GenerationControl
}
function intersection(context: NormalizeContext, members: TypeNode[], location?: string): TypeNode {
  return intersect(members, {
    location,
    onWiden: (source, reason) =>
      context.diagnostics.warn(
        "schema-precision-loss",
        reason ?? "The intersection is widened to keep TypeScript compilable",
        source ?? "#",
      ),
  })
}
