import type { BuildContext } from "./build-context"
import { componentNameOf, identity } from "./document-nodes"
import type { DocumentNode } from "./documents"
import type { TypeNode } from "./model"
import { isRecord } from "./object"
import { referencesOf } from "./object-references"

interface Discriminator {
  property: string
  mapping: Array<{ value: string; ids: Set<string> }>
  defaultIds?: Set<string>
}

/** A schema a discriminator can select: its identities and its component name. */
interface Member {
  ids: Set<string>
  name?: string
}

/** One compilation's discriminator analysis and lazily built inheritance index. */
export function createDiscriminatorAnalysis(context: BuildContext) {
  let families: Map<string, Member[]> | undefined

  /**
   * Discriminator Objects are hints that "MUST NOT change the validation outcome". They narrow
   * types where a branch leaves the property open or its string literals overlap the mapped values.
   * Disjoint literals win over a mapping; an explicit contradiction is reported instead. Narrowings
   * are recorded while building and applied by `applyNarrowing`.
   */
  function narrowDiscriminated(
    node: DocumentNode,
    keyword: "oneOf" | "anyOf",
    types: TypeNode[],
  ): TypeNode[] {
    const schema = node.value as Record<string, unknown>
    const discriminator = readDiscriminator(node)
    // With both present, the discriminator describes the oneOf.
    if (discriminator === undefined || (keyword === "anyOf" && Array.isArray(schema.oneOf))) {
      return types
    }
    return types.map((type, i) => {
      const branch = context.documents.child(node, keyword, i)
      if (referencesOf(branch.value).length === 0) return type
      const chain = refChain(branch)
      if (chain.length === 0) return type
      const member = {
        ids: new Set(chain.map((n) => identity(n))),
        name: chain.map((n) => componentNameOf(n)).find((n) => n !== undefined),
      }
      return narrow(branch, type, discriminator, [member])
    })
  }

  /**
   * Narrow a named component by the discriminators of the schemas it extends through `allOf`: such
   * a component is one of the parent's alternatives, and so is every component extending it in turn
   * (OpenAPI 3.0.4 recommends searching the components for them).
   */
  function parentDiscriminators(
    node: DocumentNode,
    componentName: string,
    type: TypeNode,
    selfIds: string[],
  ): TypeNode {
    let out = type
    const applied = new Set<string>()
    for (const parent of allOfParents(node, new Set(selfIds))) {
      const discriminator = readDiscriminator(parent)
      if (discriminator === undefined || applied.has(discriminator.property)) continue
      applied.add(discriminator.property)
      const family = [{ ids: new Set(selfIds), name: componentName }, ...descendants(selfIds)]
      out = narrow(node, out, discriminator, family)
    }
    return out
  }

  function readDiscriminator(node: DocumentNode): Discriminator | undefined {
    const schema = node.value
    if (!isRecord(schema)) return undefined
    const raw = schema.discriminator
    if (!isRecord(raw) || typeof raw.propertyName !== "string") return undefined
    const at = context.documents.child(node, "discriminator")
    const mapping: Discriminator["mapping"] = []
    if (isRecord(raw.mapping)) {
      for (const [value, target] of Object.entries(raw.mapping)) {
        if (typeof target !== "string") continue
        const ids = mappingTarget(at, target)
        if (ids) mapping.push({ value, ids })
        else {
          context.warn(
            "discriminator-mismatch",
            `Discriminator mapping "${value}" points to "${target}", which does not resolve to a schema`,
            at,
            "mapping",
          )
        }
      }
    }
    const out: Discriminator = { property: raw.propertyName, mapping }
    if (typeof raw.defaultMapping === "string" && node.document.version === "3.2") {
      out.defaultIds = mappingTarget(at, raw.defaultMapping)
    }
    return out
  }

  /**
   * Resolve a mapping value: a URI reference when it has a scheme, `/`, or `#`, else a component
   * name.
   */
  function mappingTarget(at: DocumentNode, target: string): Set<string> | undefined {
    let node: DocumentNode | undefined
    if (!/^[a-z][a-z\d+.-]*:|[/#]/i.test(target)) {
      const annotations = context.documents
      for (const document of [at.document, annotations.entry]) {
        const candidate = annotations.child(
          annotations.root(document),
          "components",
          "schemas",
          target,
        )
        if (candidate.value !== undefined) {
          node = candidate
          break
        }
      }
    } else {
      const resolution = context.documents.resolveSchema(target, at)
      if (resolution.kind === "found") node = resolution.node
      else if (resolution.kind === "pending") return new Set()
    }
    if (node === undefined) return undefined
    return new Set([identity(node), ...refChain(node).map((n) => identity(n))])
  }

  function narrow(
    at: DocumentNode,
    type: TypeNode,
    discriminator: Discriminator,
    members: Member[],
  ): TypeNode {
    const found = new Set<string>()
    let explicit = false
    for (const member of members) {
      // The default mapping target accepts values no other schema claims.
      if (discriminator.defaultIds && overlaps(discriminator.defaultIds, member.ids)) return type
      const mapped = discriminator.mapping
        .filter((m) => overlaps(m.ids, member.ids))
        .map((m) => m.value)
      if (mapped.length > 0) explicit = true
      for (const value of mapped.length > 0
        ? mapped
        : member.name === undefined
          ? []
          : [member.name]) {
        found.add(value)
      }
    }
    if (found.size === 0) return type
    // Whether the schema already fixes the property is only known once every
    // declaration is built; see `applyNarrowing`.
    return {
      kind: "narrow",
      type,
      property: discriminator.property,
      values: [...found],
      explicit,
      location: context.documents.locate(at.document, at.pointer),
    }
  }

  /** Targets of a chain of references starting at `node` (excluding `node`). */
  function refChain(node: DocumentNode): DocumentNode[] {
    const out: DocumentNode[] = []
    const seen = new Set<string>()
    let current = node
    let reference = referencesOf(current.value)[0]
    while (reference !== undefined) {
      const resolution = context.documents.resolveSchema(reference[1], current)
      if (resolution.kind !== "found") break
      const id = identity(resolution.node)
      if (seen.has(id)) break
      seen.add(id)
      out.push(resolution.node)
      current = resolution.node
      reference = referencesOf(current.value)[0]
    }
    return out
  }

  /** Schemas reachable through `allOf` references, nearest first. */
  function allOfParents(node: DocumentNode, seen: Set<string>): DocumentNode[] {
    const schema = node.value
    if (!isRecord(schema) || !Array.isArray(schema.allOf)) return []
    const out: DocumentNode[] = []
    const later: DocumentNode[] = []
    schema.allOf.forEach((_, i) => {
      const target = refChain(context.documents.child(node, "allOf", i)).at(-1)
      if (target === undefined || seen.has(identity(target))) return
      seen.add(identity(target))
      out.push(target)
      later.push(target)
    })
    for (const parent of later) out.push(...allOfParents(parent, seen))
    return out
  }

  /** Entry-document components extending (via `allOf`, transitively) the schema with `selfIds`. */
  function descendants(selfIds: string[]): Member[] {
    let children = families
    if (children === undefined) {
      children = new Map()
      const components = context.documents.child(
        context.documents.root(context.documents.entry),
        "components",
        "schemas",
      )
      for (const name of isRecord(components.value) ? Object.keys(components.value) : []) {
        const node = context.documents.child(components, name)
        const member = {
          ids: new Set([identity(node), ...refChain(node).map((n) => identity(n))]),
          name,
        }
        const schema = (refChain(node).at(-1) ?? node).value
        if (!isRecord(schema) || !Array.isArray(schema.allOf)) continue
        const owner = refChain(node).at(-1) ?? node
        schema.allOf.forEach((_, i) => {
          for (const parent of refChain(context.documents.child(owner, "allOf", i))) {
            const list = children?.get(identity(parent)) ?? []
            list.push(member)
            children?.set(identity(parent), list)
          }
        })
      }
      families = children
    }
    const out: Member[] = []
    const seen = new Set(selfIds)
    const queue = [...selfIds]
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      for (const child of children.get(id) ?? []) {
        if ([...child.ids].some((c) => seen.has(c))) continue
        for (const c of child.ids) seen.add(c)
        out.push(child)
        queue.push(...child.ids)
      }
    }
    return out
  }

  return { narrowDiscriminated, parentDiscriminators }
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  return [...a].some((value) => b.has(value))
}
