import { objectAnnotations } from "./annotations"
import type { BuildContext } from "./build-context"
import { typeOfContent } from "./content-types"
import { identity } from "./document-nodes"
import type { DocumentNode } from "./documents"
import { formEncoding } from "./form-encoding"
import { classifyMediaType, isFormData } from "./media-types"
import type { Body, Media, Operation, Response } from "./model"
import { isRecord } from "./object"
import { ParameterBuilder } from "./parameters"
import { resolveObject } from "./references"
import type { SchemaBuilder } from "./schemas"
import { union } from "./type-algebra"

const METHODS_30 = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]
const METHODS_32 = [...METHODS_30, "query"]
type Kind = "endpoint" | "webhook" | "callback"

export interface Operations {
  endpoints: Operation[]
  webhooks: Operation[]
  callbacks: Operation[]
}

/** Every operation under `paths`, `webhooks`, and (recursively) `callbacks`, in document order. */
export async function buildOperations(
  context: BuildContext,
  schemas: SchemaBuilder,
): Promise<Operations> {
  const out: Operations = { endpoints: [], webhooks: [], callbacks: [] }
  const ops = new OperationBuilder(context, schemas, out)
  const root = context.documents.root(context.documents.entry)
  const paths = context.documents.child(root, "paths")
  if (isRecord(paths.value)) {
    for (const path of Object.keys(paths.value)) {
      // The Paths Object allows specification extensions beside its paths.
      if (path.startsWith("x-")) continue
      ops.pathItem(context.documents.child(paths, path), "endpoint", path, "", new Set())
      const pending = context.documents.reader.workpoint()
      // oxlint-disable-next-line no-await-in-loop -- yield between independent path items
      if (pending) await pending
    }
  }
  const webhooks = context.documents.child(root, "webhooks")
  // A 3.1 field, applied in 3.0 too.
  if (isRecord(webhooks.value)) {
    for (const name of Object.keys(webhooks.value)) {
      ops.pathItem(context.documents.child(webhooks, name), "webhook", name, "", new Set())
      const pending = context.documents.reader.workpoint()
      // oxlint-disable-next-line no-await-in-loop -- yield between independent webhook items
      if (pending) await pending
    }
  }
  return out
}

class OperationBuilder {
  private readonly parameterBuilder: ParameterBuilder

  constructor(
    private readonly context: BuildContext,
    private readonly schemas: SchemaBuilder,
    private readonly out: Operations,
  ) {
    this.parameterBuilder = new ParameterBuilder(context, schemas)
  }

  pathItem(
    node: DocumentNode,
    kind: Kind,
    label: string,
    keyPrefix: string,
    callbacks: Set<string>,
  ): void {
    const fields = this.pathItemFields(node)
    if (fields === undefined) return
    // `query` and `additionalOperations` are 3.2 fields, applied in earlier versions too.
    const methods: Array<[method: string, node: DocumentNode]> = []
    for (const method of METHODS_32) {
      const op = fields.get(method)
      if (op !== undefined) methods.push([method.toUpperCase(), op])
    }
    const additional = fields.get("additionalOperations")
    if (additional !== undefined && isRecord(additional.value)) {
      for (const method of Object.keys(additional.value)) {
        const at = this.context.documents.child(additional, method)
        if (METHODS_32.includes(method.toLowerCase())) {
          this.context.warn(
            "ignored-field",
            `additionalOperations cannot redefine ${method}; use the "${method.toLowerCase()}" field`,
            at,
          )
          continue
        }
        methods.push([method, at])
      }
    }
    const shared = fields.get("parameters")
    const servers = fields.get("servers")
    for (const [method, op] of methods) {
      this.operation(op, method, label, kind, keyPrefix, shared, servers, callbacks)
    }
  }

  /** A Path Item's fields, merging a `$ref`'d Path Item with local fields (local wins). */
  private pathItemFields(node: DocumentNode): Map<string, DocumentNode> | undefined {
    const fields = new Map<string, DocumentNode>()
    const chain: DocumentNode[] = []
    const seen = new Set<string>()
    let current = node
    while (isRecord(current.value)) {
      const id = identity(current)
      if (seen.has(id)) {
        this.context.error("circular-ref", "Reference cycle through a Path Item", node, "$ref")
        return undefined
      }
      seen.add(id)
      chain.push(current)
      const ref = current.value.$ref
      if (typeof ref !== "string") break
      const resolution = this.context.documents.resolve(ref, current)
      if (resolution.kind === "pending") return undefined
      if (resolution.kind === "error") {
        this.context.error(
          "unresolved-ref",
          `Cannot resolve $ref "${ref}": ${resolution.message}`,
          current,
          "$ref",
        )
        return undefined
      }
      current = resolution.node
    }
    // Start at the target so each referring Path Item overrides its inherited fields.
    for (const link of chain.toReversed()) {
      for (const key of Object.keys(link.value as Record<string, unknown>)) {
        if (key === "$ref") continue
        if (fields.has(key)) {
          this.context.warn(
            "path-item-conflict",
            `"${key}" is defined both here and in the referenced Path Item; the local definition is used`,
            link,
            key,
          )
        }
        fields.set(key, this.context.documents.child(link, key))
      }
    }
    return fields
  }

  private operation(
    node: DocumentNode,
    method: string,
    label: string,
    kind: Kind,
    keyPrefix: string,
    shared: DocumentNode | undefined,
    servers: DocumentNode | undefined,
    callbacks: Set<string>,
  ): void {
    const op = node.value
    if (!isRecord(op)) return
    const key = `${keyPrefix}${method} ${label}`
    const params = this.parameterBuilder.parameters(
      shared,
      this.context.documents.child(node, "parameters"),
    )

    const operation: Operation = {
      key,
      params: this.parameterBuilder.pathParams(params.path, kind, label, node),
      query: params.query,
      headers: params.header,
      cookies: params.cookie,
      responses: this.responses(this.context.documents.child(node, "responses")),
    }
    if (params.querystring) operation.querystring = params.querystring
    const tags: Array<[string, string]> = []
    if (typeof op.operationId === "string") tags.push(["operationId", op.operationId])
    const annotations = objectAnnotations(op, tags)
    if (annotations) operation.annotations = annotations

    if ("requestBody" in op) {
      const body = this.body(this.context.documents.child(node, "requestBody"))
      // Kept on GET, HEAD, and DELETE too, which 3.0 says to ignore: the APIs
      // that declare them accept them.
      if (body) operation.body = body
    }

    if (kind === "endpoint") {
      for (const at of [this.context.documents.child(node, "servers"), servers]) {
        if (!Array.isArray(at?.value) || at.value.length === 0) continue
        this.context.warn(
          "ignored-field",
          "Servers of a path or operation are not applied: the client sends every request to its baseUrl; use a second client for these operations",
          at,
        )
      }
    }

    const list =
      kind === "endpoint"
        ? this.out.endpoints
        : kind === "webhook"
          ? this.out.webhooks
          : this.out.callbacks
    list.push(operation)

    const callbackMap = this.context.documents.child(node, "callbacks")
    if (isRecord(callbackMap.value)) {
      for (const name of Object.keys(callbackMap.value)) {
        const resolved = resolveObject(
          this.context,
          this.context.documents.child(callbackMap, name),
        )
        if (resolved === undefined || !isRecord(resolved.node.value)) continue
        // A callback that reappears within its own chain (via $ref) would expand forever.
        const id = identity(resolved.node)
        if (callbacks.has(id)) continue
        const chain = new Set(callbacks).add(id)
        for (const expression of Object.keys(resolved.node.value)) {
          if (expression.startsWith("x-")) continue
          this.pathItem(
            this.context.documents.child(resolved.node, expression),
            "callback",
            expression,
            `${key} > ${name} > `,
            chain,
          )
        }
      }
    }
  }

  private body(node: DocumentNode): Body | undefined {
    const resolved = resolveObject(this.context, node)
    if (resolved === undefined || !isRecord(resolved.node.value)) return undefined
    const content = this.content(this.context.documents.child(resolved.node, "content"), true)
    if (content.length === 0) return undefined
    const body: Body = { required: resolved.node.value.required === true, content }
    const annotations = objectAnnotations({
      description: resolved.description ?? resolved.node.value.description,
    })
    if (annotations) body.annotations = annotations
    return body
  }

  /** Media types and their types, with the Encoding Objects of form content. */
  private content(node: DocumentNode, request = false): Media[] {
    if (!isRecord(node.value)) return []
    return Object.keys(node.value).flatMap((mediaType) => {
      const media = resolveObject(this.context, this.context.documents.child(node, mediaType))
      if (media === undefined) return []
      const out: Media = {
        mediaType,
        type: typeOfContent(this.schemas, media.node, mediaType),
        location: this.context.documents.locate(media.node.document, media.node.pointer),
      }
      // The client encodes multipart fields only for requests, and only named ones (form-data).
      const multipart = request && isFormData(mediaType)
      if (multipart || (request && classifyMediaType(mediaType) === "form")) {
        const encoding = formEncoding(this.context, media.node, multipart)
        if (encoding) out.encoding = encoding
      }
      return [out]
    })
  }

  private responses(node: DocumentNode): Response[] {
    if (!isRecord(node.value)) return []
    const out: Response[] = []
    for (const key of Object.keys(node.value)) {
      if (key.startsWith("x-")) continue
      const status = this.statusKey(key, node)
      const resolved = resolveObject(this.context, this.context.documents.child(node, key))
      if (resolved === undefined || !isRecord(resolved.node.value)) continue
      const value = resolved.node.value
      const response: Response = {
        status,
        content: this.content(this.context.documents.child(resolved.node, "content")),
        headers: this.parameterBuilder.responseHeaders(
          this.context.documents.child(resolved.node, "headers"),
        ),
      }
      const annotations = objectAnnotations({
        summary: resolved.summary ?? value.summary,
        description: resolved.description ?? value.description,
      })
      if (annotations) response.annotations = annotations
      const same = out.find((r) => r.status === status)
      if (same) {
        // `2xx` and `2XX` describe the same responses.
        for (const media of response.content) {
          const existing = same.content.find((m) => m.mediaType === media.mediaType)
          if (existing) existing.type = union([existing.type, media.type])
          else same.content.push(media)
        }
        continue
      }
      out.push(response)
    }
    return out
  }

  private statusKey(key: string, at: DocumentNode): string {
    if (key === "default" || /^[1-5](\d\d|XX)$/.test(key)) return key
    // A range in lowercase means the same range.
    if (/^[1-5]xx$/i.test(key)) return key.toUpperCase()
    this.context.warn(
      "invalid-status-code",
      `"${key}" is not an HTTP status code, range, or "default"`,
      at,
      key,
    )
    return key
  }
}
