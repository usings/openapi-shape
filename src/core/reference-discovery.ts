import { selectContentSource, selectParameterValue } from "./content-sources"
import { componentNameOf, identity } from "./document-nodes"
import type { DocumentNode, DocumentSet } from "./documents"
import type { GenerationControl } from "./generation-control"
import { isRecord } from "./object"
import { selectOperations, selectParameterSources, selectPathItem } from "./operation-sources"
import { inspectObject, referencesOf } from "./references"
import { aliasReference } from "./schema-rules"

/**
 * Discover the reference graph before compiling types. Work items describe semantic positions,
 * never arbitrary JSON subtrees: examples, extensions, and unused components cannot trigger I/O. A
 * pending item is retried after loading; completed positions are visited only once.
 */
export function discoverReferences(
  documents: DocumentSet,
  control: GenerationControl,
): Promise<{ repeated: Set<string>; exhausted: boolean }> {
  const discovery = new ReferenceDiscovery(documents, control)
  discovery.start()
  return discovery.run()
}

class ReferenceDiscovery {
  private queue: Array<() => boolean> = []
  private readonly visited = new Set<string>()
  private readonly incoming = new Map<string, Set<string>>()
  private retry = false

  constructor(
    private readonly documents: DocumentSet,
    private readonly control: GenerationControl,
  ) {}

  start(): void {
    const root = this.documents.root(this.documents.entry)
    this.each(this.documents.child(root, "components", "schemas"), (node) => this.schema(node))
    this.each(this.documents.child(root, "paths"), (node) => this.pathItem(node), true)
    this.each(this.documents.child(root, "webhooks"), (node) => this.pathItem(node))
  }

  async run(): Promise<{ repeated: Set<string>; exhausted: boolean }> {
    let exhausted = false
    while (this.queue.length > 0) {
      const pending: Array<() => boolean> = []
      // Tasks may append newly reached positions to this same queue.
      for (const task of this.queue) {
        this.retry = false
        if (!task() || this.retry) pending.push(task)
        const checkpoint = this.control.workpoint()
        // oxlint-disable-next-line no-await-in-loop -- yield between graph positions
        if (checkpoint) await checkpoint
      }
      this.queue = pending
      if (pending.length === 0 || !this.documents.hasPending) break
      // oxlint-disable-next-line no-await-in-loop -- each load unlocks the next graph frontier
      if (!(await this.documents.loadPending())) {
        exhausted = true
        break
      }
    }
    return {
      repeated: new Set(
        [...this.incoming].filter(([, sources]) => sources.size > 1).map(([id]) => id),
      ),
      exhausted,
    }
  }

  private task(role: string, node: DocumentNode, visit: () => boolean): void {
    const key = `${role}:${identity(node)}`
    if (this.visited.has(key)) return
    this.visited.add(key)
    this.queue.push(visit)
  }

  private each(node: DocumentNode, visit: (node: DocumentNode) => void, extensions = false): void {
    if (!isRecord(node.value)) return
    for (const key of Object.keys(node.value)) {
      if (extensions && key.startsWith("x-")) continue
      visit(this.documents.child(node, key))
    }
  }

  /** Undefined means loading; null means invalid (reported during compilation). */
  private object(node: DocumentNode): DocumentNode | null | undefined {
    const result = inspectObject(this.documents, node)
    if (result.kind === "pending") return undefined
    if (result.kind === "error") {
      // A later dictionary promotion may expose a previously missing anchor.
      if (result.issue.code === "unresolved-ref") this.retry = true
      return null
    }
    return result.value.node
  }

  private reference(node: DocumentNode, keyword: string, ref: string, compile = true): void {
    this.task(`${compile ? "reference" : "mapping"}:${keyword}`, node, () => {
      const result = this.documents.resolveSchema(ref, node)
      if (result.kind !== "found") return false
      if (compile) {
        const id = identity(result.node)
        const sources = this.incoming.get(id) ?? new Set<string>()
        sources.add(`${identity(node)}:${keyword}`)
        this.incoming.set(id, sources)
        this.schema(result.node)
      } else this.mappingChain(result.node)
      return true
    })
  }

  /** Mapping targets contribute identity chains, not schema types. */
  private mappingChain(node: DocumentNode): void {
    this.task("mapping-chain", node, () => {
      const reference = referencesOf(node.value)[0]
      if (reference) this.reference(node, reference[0], reference[1], false)
      return true
    })
  }

  private schema(node: DocumentNode): void {
    this.task("schema", node, () => {
      const value = node.value
      if (!isRecord(value)) return true
      for (const [keyword, ref] of referencesOf(value)) this.reference(node, keyword, ref)
      if (componentNameOf(node) !== undefined) this.inheritance(node)
      if (value.not === true || (isRecord(value.not) && Object.keys(value.not).length === 0))
        return true
      for (const key of ["allOf", "anyOf", "oneOf"]) {
        const list = value[key]
        if (Array.isArray(list))
          list.forEach((_, i) => this.schema(this.documents.child(node, key, i)))
      }
      if ("if" in value && "else" in value) {
        for (const key of ["if", "then", "else"]) {
          if (key in value) this.schema(this.documents.child(node, key))
        }
      }
      const types =
        typeof value.type === "string"
          ? [value.type]
          : Array.isArray(value.type)
            ? value.type
            : undefined
      if (!("const" in value) && !Array.isArray(value.enum)) {
        if (types === undefined || types.includes("object")) {
          for (const key of ["properties", "patternProperties"]) {
            this.each(this.documents.child(node, key), (child) => this.schema(child))
          }
          if (isRecord(value.additionalProperties))
            this.schema(this.documents.child(node, "additionalProperties"))
        }
        if (types === undefined || types.includes("array")) {
          const prefix = Array.isArray(value.items)
            ? "items"
            : Array.isArray(value.prefixItems)
              ? "prefixItems"
              : undefined
          if (prefix) {
            ;(value[prefix] as unknown[]).forEach((_, i) =>
              this.schema(this.documents.child(node, prefix, i)),
            )
            this.schema(
              this.documents.child(node, prefix === "items" ? "additionalItems" : "items"),
            )
          } else if ("items" in value) this.schema(this.documents.child(node, "items"))
        }
      }
      if (Array.isArray(value.oneOf) || Array.isArray(value.anyOf)) this.discriminator(node)
      return true
    })
  }

  /** Component aliases inherit their target's allOf parents and discriminator annotations. */
  private inheritance(node: DocumentNode): void {
    this.task("inheritance", node, () => {
      const alias = aliasReference(node)
      if (alias) {
        const target = this.documents.resolveSchema(alias[1], node)
        if (target.kind !== "found") return false
        this.inheritance(target.node)
      }
      if (isRecord(node.value) && Array.isArray(node.value.allOf)) {
        node.value.allOf.forEach((_, i) => this.parent(this.documents.child(node, "allOf", i)))
      }
      return true
    })
  }

  private parent(node: DocumentNode): void {
    this.task("parent", node, () => {
      const seen = new Set<string>()
      let current = node
      let last: DocumentNode | undefined
      for (
        let reference = referencesOf(current.value)[0];
        reference;
        reference = referencesOf(current.value)[0]
      ) {
        const target = this.documents.resolveSchema(reference[1], current)
        if (target.kind !== "found") return false
        if (seen.has(identity(target.node))) break
        seen.add(identity(target.node))
        current = target.node
        last = current
      }
      if (last) {
        this.discriminator(last)
        this.inheritance(last)
      }
      return true
    })
  }

  private discriminator(node: DocumentNode): void {
    if (!isRecord(node.value) || !isRecord(node.value.discriminator)) return
    const raw = node.value.discriminator
    if (typeof raw.propertyName !== "string") return
    const at = this.documents.child(node, "discriminator")
    const entries: Array<readonly [string, unknown]> = isRecord(raw.mapping)
      ? Object.entries(raw.mapping).map(([key, value]) => [`mapping/${key}`, value] as const)
      : []
    if (node.document.version === "3.2") entries.push(["defaultMapping", raw.defaultMapping])
    for (const [key, target] of entries) {
      if (typeof target !== "string") continue
      if (/^[a-z][a-z\d+.-]*:|[/#]/i.test(target)) this.reference(at, key, target, false)
      else {
        for (const document of [node.document, this.documents.entry]) {
          const candidate = this.documents.child(
            this.documents.root(document),
            "components",
            "schemas",
            target,
          )
          if (candidate.value === undefined) continue
          this.mappingChain(candidate)
          break
        }
      }
    }
  }

  private pathItem(node: DocumentNode): void {
    this.task("path-item", node, () => {
      const result = selectPathItem(this.documents, node)
      if (result.kind === "pending") return false
      if (result.kind === "error") return result.issue.code === "circular-ref"
      const { fields } = result.value
      const shared = fields.get("parameters")
      for (const [, operation] of selectOperations(this.documents, fields).methods)
        this.operation(operation, shared)
      return true
    })
  }

  private operation(node: DocumentNode, shared?: DocumentNode): void {
    this.task(`operation:${shared ? identity(shared) : ""}`, node, () => {
      if (!isRecord(node.value)) return true
      const selection = selectParameterSources(
        this.documents,
        shared,
        this.documents.child(node, "parameters"),
      )
      if (selection.issues.some((issue) => issue.code === "unresolved-ref")) this.retry = true
      if (!selection.pending)
        for (const parameter of selection.selected) this.parameter(parameter.at.node)
      this.container(this.documents.child(node, "requestBody"), "body")
      this.each(
        this.documents.child(node, "responses"),
        (response) => this.container(response, "response"),
        true,
      )
      this.each(this.documents.child(node, "callbacks"), (callback) => {
        this.task("callback", callback, () => {
          const target = this.object(callback)
          if (target === undefined) return false
          if (target) this.each(target, (path) => this.pathItem(path), true)
          return true
        })
      })
      return !selection.pending
    })
  }

  private parameter(node: DocumentNode): void {
    this.task("parameter", node, () => {
      const target = this.object(node)
      if (target === undefined) return false
      if (!target || !isRecord(target.value)) return true
      const source = selectParameterValue(this.documents, target)
      if (source.kind === "schema") this.schema(source.node)
      else if (source.kind === "content")
        this.media(source.node, source.mediaType, target.value.in !== "querystring")
      return true
    })
  }

  private container(node: DocumentNode, role: "body" | "response"): void {
    this.task(role, node, () => {
      const target = this.object(node)
      if (target === undefined) return false
      if (!target) return true
      const content = this.documents.child(target, "content")
      if (isRecord(content.value)) {
        for (const mediaType of Object.keys(content.value))
          this.media(this.documents.child(content, mediaType), mediaType)
      }
      if (role === "response") {
        const headers = this.documents.child(target, "headers")
        if (isRecord(headers.value))
          for (const name of Object.keys(headers.value)) {
            if (name.toLowerCase() !== "content-type")
              this.parameter(this.documents.child(headers, name))
          }
      }
      return true
    })
  }

  private media(node: DocumentNode, mediaType: string, parameter = false): void {
    this.task(`media:${mediaType}:${parameter}`, node, () => {
      const target = this.object(node)
      if (target === undefined) return false
      if (!target || !isRecord(target.value)) return true
      const { source } = selectContentSource(this.documents, target, mediaType, parameter)
      if (source.kind === "unresolved") return false
      if (source.kind === "schema" || source.kind === "items") this.schema(source.node)
      return true
    })
  }
}
