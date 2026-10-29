import type { EndpointContract } from "../../shared/contract"
import { streamFormat } from "../../shared/media"
import type { BodyOwner } from "../cancellation"
import { abortable, cancelBody } from "../cancellation"
import { mergeHeaders } from "../headers"
import { matchDeclaredMedia, responseContentType } from "../media"
import type { MiddlewareContext, Sender } from "../middleware"
import type { CallInit, RequestDefaults } from "../request"
import { buildRequest } from "../request"
import { resolveResponseDeclaration } from "../response"
import type { StreamOptions } from "../types/stream"
import { isStream } from "../values"
import { readJsonSequence } from "./json-seq-parser"
import { readJsonLines } from "./jsonl-parser"
import { messageLimit } from "./message-buffer"
import type { EventState } from "./sse-parser"
import { StreamReadError, readEvents } from "./sse-parser"
import { RetryableStreamError, retryAfterDelay, sseSession, validateRetry } from "./sse-retry"

/** A refused response. Status and headers remain readable after its body is canceled. */
export class StreamResponseError extends Error {
  constructor(
    message: string,
    readonly response: Response,
  ) {
    super(message)
    this.name = "StreamResponseError"
  }
}

/** Adapt one lazy subscription to standard Streams demand and cancellation. */
export function stream(
  endpoint: string,
  init: CallInit & StreamOptions,
  defaults: RequestDefaults,
  send: Sender,
): ReadableStream<unknown> {
  const externalSignal = init.signal
  const abortController = new AbortController()
  let iterator: AsyncGenerator<unknown, void> | undefined
  let terminal = false
  let cleanup: Promise<void> | undefined
  const owner: BodyOwner = {}
  let controller: ReadableStreamDefaultController<unknown>
  const dispose = (reason?: unknown): Promise<void> => {
    if (cleanup) return cleanup
    externalSignal?.removeEventListener("abort", abort)
    // Cancel the owned reader first: aborting Fetch can synchronously error its body.
    const bodyCleanup = owner.cancel?.(reason)
    void bodyCleanup?.catch(() => {
      /* Observed by the returned cleanup promise. */
    })
    abortController.abort(reason)
    cleanup = (async () => {
      try {
        await iterator?.return()
      } finally {
        await bodyCleanup
      }
    })()
    return cleanup
  }
  const abort = (): void => {
    if (terminal) return
    terminal = true
    controller.error(externalSignal?.reason)
    void dispose(externalSignal?.reason).catch(() => {
      /* Keep the abort reason. */
    })
  }
  return new ReadableStream<unknown>(
    {
      start(sourceController) {
        controller = sourceController
        if (externalSignal?.aborted) abort()
        else externalSignal?.addEventListener("abort", abort, { once: true })
      },
      async pull() {
        if (terminal) return
        try {
          iterator ??= subscription(endpoint, init, defaults, send, abortController.signal, owner)
          const result = await iterator.next()
          if (terminal) return
          if (result.done) {
            terminal = true
            controller.close()
            externalSignal?.removeEventListener("abort", abort)
          } else controller.enqueue(result.value)
        } catch (error) {
          if (terminal) return
          terminal = true
          controller.error(error)
          await dispose(error).catch(() => {
            /* Keep the stream failure. */
          })
        }
      },
      cancel(reason) {
        terminal = true
        return dispose(reason)
      },
    },
    { highWaterMark: 0 },
  )
}

/**
 * Send once without buffering, or snapshot a replayable body when SSE reconnection is enabled.
 *
 * @yields Parsed items of the selected response representation.
 */
async function* subscription(
  endpoint: string,
  init: CallInit & StreamOptions,
  defaults: RequestDefaults,
  send: Sender,
  signal: AbortSignal,
  owner: BodyOwner,
): AsyncGenerator<unknown, void> {
  signal.throwIfAborted()
  const media = Object.hasOwn(defaults.endpoints, endpoint)
    ? defaults.endpoints[endpoint] &&
      collectStreamMedia(defaults.endpoints[endpoint], endpoint.split(" ")[0])
    : undefined
  if (!media?.length)
    throw new TypeError(`Endpoint "${endpoint}" does not declare a successful streaming response`)
  const { retry, maxMessageBytes, ...call } = init
  const selectionHeaders = mergeHeaders(
    defaults.headers,
    init.headers,
    defaults.endpoints[endpoint]?.parameters?.header,
  )
  const accept = selectionHeaders.get("accept") ?? undefined
  const limit = messageLimit(maxMessageBytes)
  const selected =
    accept && media.includes(accept)
      ? accept
      : accept === undefined && media.length === 1
        ? media[0]
        : undefined
  const format = selected ? streamFormat(selected) : undefined
  if (format !== "sse" && retry !== undefined && retry !== false)
    throw new TypeError("Automatic retry requires a single SSE media selection")
  const replay =
    format === "sse" && retry !== undefined && retry !== false && retry.maxRetries !== 0
  if (replay && isStream(call.body))
    throw new TypeError("SSE reconnection cannot replay a streaming request body; set retry: false")
  const state: EventState = { id: "", retry: format === "sse" ? validateRetry(retry) : 1000 }
  const template = buildRequest(endpoint, { ...call, signal }, defaults)
  const body =
    !replay || template.body === null ? undefined : await abortable(template.arrayBuffer(), signal)
  const headers = new Headers(template.headers)
  if (!accept) headers.set("accept", selected ?? media.join(", "))
  const initialId = headers.get("last-event-id") ?? ""
  state.id = new TextDecoder().decode(Uint8Array.from(initialId, (char) => char.charCodeAt(0)))
  const context: MiddlewareContext = { endpoint, kind: "stream" }
  let first = true
  const connect = (): AsyncGenerator<unknown, boolean> => {
    const own = new Headers(headers)
    if (format === "sse" && !first) {
      if (state.id) own.set("last-event-id", headerId(state.id))
      else own.delete("last-event-id")
    }
    first = false
    const request = new Request(template, { headers: own, ...(body === undefined ? {} : { body }) })
    return connection(
      request,
      selected,
      state,
      send,
      context,
      signal,
      owner,
      limit,
      defaults.endpoints[endpoint],
    )
  }
  if (format === "sse") yield* sseSession(connect, state, retry, signal)
  else yield* connect()
}

/**
 * Own only the delivered response for one connection.
 *
 * @yields Parsed items from this connection only.
 */
async function* connection(
  request: Request,
  selected: string | undefined,
  state: EventState,
  send: Sender,
  context: MiddlewareContext,
  signal: AbortSignal,
  owner: BodyOwner,
  maxMessageBytes: number,
  declared?: EndpointContract,
): AsyncGenerator<unknown, boolean> {
  const transportFailures: unknown[] = []
  let response: Response | undefined
  const sse = selected !== undefined && streamFormat(selected) === "sse"
  try {
    signal.throwIfAborted()
    try {
      response = await send(request, context, (error) => transportFailures.push(error))
    } catch (error) {
      signal.throwIfAborted()
      if (sse && transportFailures.some((failure) => Object.is(failure, error)))
        throw new RetryableStreamError(error)
      throw error
    }
    signal.throwIfAborted()
    if (response.status === 204) return true
    if (!response.ok) {
      const error = new StreamResponseError(
        `Stream request failed with status ${response.status}`,
        response,
      )
      if (
        sse &&
        (response.status === 408 ||
          response.status === 429 ||
          (response.status >= 500 && response.status < 600))
      )
        throw new RetryableStreamError(error, retryAfterDelay(response))
      throw error
    }
    const shape = declared && resolveResponseDeclaration(declared, response.status)
    if (!shape)
      throw new StreamResponseError("Response status is not declared by this operation", response)
    const actual = responseContentType(response.headers)
    const matched = actual && shape.content && matchDeclaredMedia(shape.content, actual)
    const format = matched ? streamFormat(matched) : undefined
    if (
      !format ||
      (selected !== undefined && matched !== selected) ||
      response.body === null ||
      response.bodyUsed ||
      response.body.locked
    )
      throw new StreamResponseError(
        `Expected an unused ${selected ?? "declared streaming"} response body`,
        response,
      )
    if (format === "sse") {
      try {
        yield* readEvents(response.body, state, signal, owner, maxMessageBytes)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof StreamReadError) {
          if (sse) throw new RetryableStreamError(error.cause)
          throw error.cause
        }
        throw error
      }
    } else if (format === "json-seq")
      yield* readJsonSequence(response.body, signal, owner, maxMessageBytes)
    else yield* readJsonLines(response.body, signal, owner, maxMessageBytes)
    return false
  } finally {
    if (response && !response.body?.locked) cancelBody(response, signal.reason)
  }
}

/** Fetch headers take byte strings; SSE resume IDs are UTF-8 bytes on the wire. */
function headerId(id: string): string {
  let value = ""
  for (const byte of new TextEncoder().encode(id)) value += String.fromCharCode(byte)
  return value
}

/** Successful streaming media, excluding statuses whose responses cannot carry content. */
export function collectStreamMedia(endpoint: EndpointContract, method = "GET"): string[] {
  if (method.toUpperCase() === "HEAD") return []
  const effective = new Set<object>()
  for (let status = 200; status < 300; status++) {
    if (status === 204 || status === 205) continue
    const shape =
      endpoint.responses[String(status)] ?? endpoint.responses["2XX"] ?? endpoint.responses.default
    if (shape) effective.add(shape)
  }
  return [
    ...new Set(
      Object.values(endpoint.responses).flatMap((shape) =>
        effective.has(shape)
          ? Object.keys(shape.content ?? {}).filter((key) => streamFormat(key))
          : [],
      ),
    ),
  ]
}
