import { mediaTypeEssence, streamFormat } from "../shared/media"
import { abortable, cancelBody } from "./cancellation"
import { readJsonLines } from "./ndjson-parser"
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

/** Observe the actual transport boundary without changing errors seen by middleware. */
export interface StreamAttempt {
  received: (response: Response) => void
  failed: (error: unknown) => void
}
export type StreamSender = (request: Request, attempt: StreamAttempt) => Promise<Response>

/** Adapt one lazy subscription to standard Streams demand and cancellation. */
export function stream(
  endpoint: string,
  init: CallInit & StreamOptions,
  defaults: RequestDefaults,
  send: StreamSender,
): ReadableStream<unknown> {
  const externalSignal = init.signal
  const abortController = new AbortController()
  let iterator: AsyncGenerator<unknown, void> | undefined
  let terminal = false
  let cleanup: Promise<void> | undefined
  let controller: ReadableStreamDefaultController<unknown>
  const dispose = (reason?: unknown): Promise<void> => {
    if (cleanup) return cleanup
    externalSignal?.removeEventListener("abort", abort)
    abortController.abort(reason)
    cleanup = (async () => {
      try {
        await iterator?.return()
      } catch {
        // A terminal subscription keeps its original reason.
      }
    })()
    return cleanup
  }
  const abort = (): void => {
    if (terminal) return
    terminal = true
    controller.error(externalSignal?.reason)
    void dispose(externalSignal?.reason)
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
          iterator ??= subscription(endpoint, init, defaults, send, abortController.signal)
          const result = await iterator.next()
          if (terminal) return
          if (result.done) {
            terminal = true
            controller.close()
            await dispose()
          } else controller.enqueue(result.value)
        } catch (error) {
          if (terminal) return
          terminal = true
          controller.error(error)
          await dispose(error)
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
 * Build and encode once at first demand, then replay those bytes through fresh middleware attempts.
 *
 * @yields Parsed items of the selected response representation.
 */
async function* subscription(
  endpoint: string,
  init: CallInit & StreamOptions,
  defaults: RequestDefaults,
  send: StreamSender,
  signal: AbortSignal,
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
    throw new TypeError("JSON line streams do not support automatic retry")
  if (isStream(call.body)) throw new TypeError("api.stream cannot replay a streaming request body")
  const state: EventState = { id: "", retry: format === "sse" ? validateRetry(retry) : 1000 }
  const template = buildRequest(endpoint, { ...call, signal }, defaults)
  const body = template.body === null ? undefined : await abortable(template.arrayBuffer(), signal)
  const headers = new Headers(template.headers)
  headers.set("accept", selected)
  const initialId = headers.get("last-event-id") ?? ""
  state.id = new TextDecoder().decode(Uint8Array.from(initialId, (char) => char.charCodeAt(0)))
  let first = true
  const connect = (): AsyncGenerator<unknown, boolean> => {
    const own = new Headers(headers)
    if (format === "sse" && !first) {
      if (state.id) own.set("last-event-id", headerId(state.id))
      else own.delete("last-event-id")
    }
    first = false
    const request = new Request(template, { headers: own, ...(body === undefined ? {} : { body }) })
    return connection(request, selected, state, send, signal)
  }
  if (format === "sse") yield* sseSession(connect, state, retry, signal)
  else yield* connect()
}

/**
 * Own every response produced by one middleware traversal, including late and replaced responses.
 *
 * @yields Parsed items from this connection only.
 */
async function* connection(
  request: Request,
  selected: string,
  state: EventState,
  send: StreamSender,
  signal: AbortSignal,
): AsyncGenerator<unknown, boolean> {
  const responses = new Set<Response>()
  const transportFailures: unknown[] = []
  let finished = false
  const attempt: StreamAttempt = {
    received(response) {
      if (finished || signal.aborted) cancelBody(response)
      else responses.add(response)
    },
    failed(error) {
      transportFailures.push(error)
    },
  }
  const sse = streamFormat(selected) === "sse"
  try {
    signal.throwIfAborted()
    const pending = send(request, attempt).then((response) => {
      attempt.received(response)
      return response
    })
    let response: Response
    try {
      response = await abortable(pending, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (sse && transportFailures.some((failure) => Object.is(failure, error)))
        throw new RetryableStreamError(error)
      throw error
    }
    signal.throwIfAborted()
    // A middleware may return a clone or a replacement. Retire unused branches now,
    // rather than letting them buffer for the lifetime of a long-running subscription.
    for (const received of responses) {
      if (received !== response && received.body !== response.body) {
        cancelBody(received)
        responses.delete(received)
      }
    }
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
      mediaTypeEssence(response.headers.get("content-type") ?? "") !== mediaTypeEssence(selected) ||
      response.body === null ||
      response.bodyUsed ||
      response.body.locked
    )
      throw new StreamResponseError(`Expected an unused ${selected} response body`, response)
    if (sse) {
      try {
        yield* readEvents(response.body, state, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof StreamReadError) throw new RetryableStreamError(error.cause)
        throw error
      }
    } else yield* readJsonLines(response.body, signal)
    return false
  } finally {
    finished = true
    for (const response of responses) cancelBody(response)
    responses.clear()
  }
}

/** Fetch headers take byte strings; SSE resume IDs are UTF-8 bytes on the wire. */
function headerId(id: string): string {
  let value = ""
  for (const byte of new TextEncoder().encode(id)) value += String.fromCharCode(byte)
  return value
}
