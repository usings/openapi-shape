import { mediaTypeEssence, streamFormat } from "../shared/media"
import type { BodyOwner } from "./cancellation"
import { abortable, cancelBody } from "./cancellation"
import { readJsonSequence } from "./json-seq-parser"
import { readJsonLines } from "./jsonl-parser"
import { responseMediaType } from "./media"
import type { MiddlewareContext, Sender } from "./middleware"
import type { CallInit, RequestDefaults } from "./request"
import { buildRequest } from "./request"
import type { EventState } from "./sse-parser"
import { readEvents, StreamReadError } from "./sse-parser"
import { RetryableStreamError, retryAfterDelay, sseSession, validateRetry } from "./sse-retry"
import type { StreamOptions } from "./types"
import { isStream } from "./values"

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
    const bodyCleanup = owner.reader?.cancel(reason)
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
    ? defaults.endpoints[endpoint]?.stream
    : undefined
  if (!media?.length)
    throw new TypeError(`Endpoint "${endpoint}" does not declare a successful streaming response`)
  const { accept, retry, ...call } = init
  const selected = accept ?? (media.length === 1 ? media[0] : undefined)
  if (selected === undefined || !media.includes(selected))
    throw new TypeError(`Choose a declared streaming media type with accept for "${endpoint}"`)
  const format = streamFormat(selected)
  if (format === undefined) throw new TypeError(`Unsupported streaming media type "${selected}"`)
  if (format !== "sse" && retry !== undefined)
    throw new TypeError("JSON streams do not support automatic retry")
  const replay = format === "sse" && retry !== false && retry?.maxRetries !== 0
  if (replay && isStream(call.body))
    throw new TypeError("SSE reconnection cannot replay a streaming request body; set retry: false")
  const state: EventState = { id: "", retry: format === "sse" ? validateRetry(retry) : 1000 }
  const template = buildRequest(endpoint, { ...call, signal }, defaults)
  const body =
    !replay || template.body === null ? undefined : await abortable(template.arrayBuffer(), signal)
  const headers = new Headers(template.headers)
  headers.set("accept", selected)
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
    return connection(request, selected, state, send, context, signal, owner)
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
  selected: string,
  state: EventState,
  send: Sender,
  context: MiddlewareContext,
  signal: AbortSignal,
  owner: BodyOwner,
): AsyncGenerator<unknown, boolean> {
  const transportFailures: unknown[] = []
  let response: Response | undefined
  const sse = streamFormat(selected) === "sse"
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
    if (
      responseMediaType(response.headers) !== mediaTypeEssence(selected) ||
      response.body === null ||
      response.bodyUsed ||
      response.body.locked
    )
      throw new StreamResponseError(`Expected an unused ${selected} response body`, response)
    if (sse) {
      try {
        yield* readEvents(response.body, state, signal, owner)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof StreamReadError) throw new RetryableStreamError(error.cause)
        throw error
      }
    } else if (streamFormat(selected) === "json-seq")
      yield* readJsonSequence(response.body, signal, owner)
    else yield* readJsonLines(response.body, signal, owner)
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
