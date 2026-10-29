import type { Diagnostics } from "./diagnostics"
import type { ApiModel, OperationModel, TypeDeclaration, TypeNode } from "./model"
import { childTypes } from "./model"
import { uniqueName } from "./naming"

/** Name directional variants only for declarations used in outgoing data. */
export function assignInputVariants(model: ApiModel, diagnostics: Diagnostics): void {
  const sent = [
    ...model.operations.flatMap((op) => requestTypes(op)),
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

function requestTypes(op: OperationModel): TypeNode[] {
  return [
    ...[...op.params, ...op.query, ...op.headers, ...op.cookies].map((f) => f.type),
    ...(op.querystring ? [op.querystring.type] : []),
    ...(op.body?.content ?? []).map((media) => media.type),
  ]
}

function responseTypes(op: OperationModel): TypeNode[] {
  return op.responses.flatMap((r) => [
    ...r.content.map((media) => media.type),
    ...r.headers.map((f) => f.type),
  ])
}

/**
 * Give a request-side name to declarations whose required properties differ between the two sides
 * (readOnly/writeOnly), when something the client sends (`sent`) uses them.
 */
function assignInputNames(declarations: TypeDeclaration[], sent: TypeNode[]): TypeDeclaration[] {
  const differs = new Set<TypeDeclaration>()
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

  const used = new Set<TypeDeclaration>()
  const mark = (type: TypeNode): void =>
    forEachRef(type, (target) => {
      if (!differs.has(target) || used.has(target)) return
      used.add(target)
      mark(target.type)
    })
  for (const type of sent) mark(type)

  const taken = new Set(declarations.map((d) => d.name))
  const variants: TypeDeclaration[] = []
  for (const declaration of declarations) {
    if (!used.has(declaration)) continue
    declaration.inputName = uniqueName(`${declaration.name}Input`, taken)
    taken.add(declaration.inputName)
    variants.push(declaration)
  }
  return variants
}

function hasOneSidedField(
  type: TypeNode,
  differs: Set<TypeDeclaration>,
  seen: Set<TypeNode>,
): boolean {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.kind === "ref") return differs.has(type.target)
  if (type.kind === "object" && type.fields.some((f) => f.requiredOnly !== undefined)) return true
  return childTypes(type).some((t) => hasOneSidedField(t, differs, seen))
}

function forEachRef(type: TypeNode, visit: (target: TypeDeclaration) => void): void {
  if (type.kind === "ref") visit(type.target)
  for (const child of childTypes(type)) forEachRef(child, visit)
}
