import type { EndpointContract } from "../../shared/contract"
import { streamFormat } from "../../shared/media"
import type { BodyOwner } from "../cancellation"
import { raceWithAbort, cancelBody } from "../cancellation"
import { ClientError } from "../errors"
import { mergeHeaders } from "../headers"
import { matchDeclaredMedia, responseContentType } from "../media"
import type { MiddlewareContext } from "../middleware"
import type { RequestDispatcher } from "../exchange"
import type { CallInit, RequestDefaults } from "../request"
import { buildRequest } from "../request"
import { resolveResponseDeclaration } from "../response"
import type { StreamOptions } from "../types/stream"
import { isStream } from "../values"
import { messageLimit } from "./message-buffer"
import { readJsonSequence } from "./parser-json-seq"
import { readJsonLines } from "./parser-jsonl"
import type { EventState } from "./parser-sse"
import { readEvents } from "./parser-sse"
import type { ConnectionResult } from "./sse-reconnect"
import { retryAfterDelay, reconnectSSE, validateReconnect } from "./sse-reconnect"

/** Adapt one lazy subscription to standard Streams demand and cancellation. */
export function stream(
  endpoint: string,
  init: CallInit & StreamOptions,
  defaults: RequestDefaults,
  send: RequestDispatcher,
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
  send: RequestDispatcher,
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
  const { reconnect, maxMessageBytes, ...call } = init
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
  if (format !== "sse" && reconnect !== undefined && reconnect !== false)
    throw new TypeError("Automatic reconnect requires a single SSE media selection")
  const replay =
    format === "sse" &&
    reconnect !== undefined &&
    reconnect !== false &&
    (reconnect === true || reconnect.maxAttempts !== 1)
  if (replay && isStream(call.body))
    throw new TypeError(
      "SSE reconnection cannot replay a streaming request body; set reconnect: false",
    )
  const state: EventState = {
    id: "",
    retry: format === "sse" ? validateReconnect(reconnect) : 1000,
  }
  const template = buildRequest(endpoint, { ...call, signal }, defaults)
  const body =
    !replay || template.body === null ? undefined : await raceWithAbort(template.arrayBuffer(), signal)
  const headers = new Headers(template.headers)
  if (!accept) headers.set("accept", selected ?? media.join(", "))
  const initialId = headers.get("last-event-id") ?? ""
  state.id = new TextDecoder().decode(Uint8Array.from(initialId, (char) => char.charCodeAt(0)))
  const context: MiddlewareContext = { endpoint, kind: "stream" }
  let first = true
  const connect = (): AsyncGenerator<unknown, ConnectionResult> => {
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
  if (format === "sse") yield* reconnectSSE(connect, state, reconnect, signal)
  else {
    const result = yield* connect()
    signal.throwIfAborted()
    if (result.kind === "interrupted") throw result.error
  }
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
  send: RequestDispatcher,
  context: MiddlewareContext,
  signal: AbortSignal,
  owner: BodyOwner,
  maxMessageBytes: number,
  declared?: EndpointContract,
): AsyncGenerator<unknown, ConnectionResult> {
  const transportFailures: unknown[] = []
  let response: Response | undefined
  try {
    signal.throwIfAborted()
    try {
      response = await send(request, context, (error) => transportFailures.push(error))
    } catch (error) {
      signal.throwIfAborted()
      if (transportFailures.some((failure) => Object.is(failure, error)))
        return { kind: "interrupted", error, retryAfter: 0 }
      throw error
    }
    signal.throwIfAborted()
    if (response.status === 204) return { kind: "stop" }
    if (!response.ok) {
      const error = new ClientError(`Stream request failed with status ${response.status}`, {
        code: "HTTP_ERROR",
        details: { response },
      })
      if (
        response.status === 408 ||
        response.status === 429 ||
        (response.status >= 500 && response.status < 600)
      )
        return { kind: "interrupted", error, retryAfter: retryAfterDelay(response) }
      throw error
    }
    const shape = declared && resolveResponseDeclaration(declared, response.status)
    if (!shape)
      throw new ClientError("Response status is not declared by this operation", {
        code: "UNDECLARED_STATUS",
        details: { response },
      })
    const actual = responseContentType(response.headers)
    const matched = actual && shape.content && matchDeclaredMedia(shape.content, actual)
    const format = matched ? streamFormat(matched) : undefined
    if (!format || (selected !== undefined && matched !== selected))
      throw new ClientError("Response media does not match a declared streaming representation", {
        code: "UNEXPECTED_MEDIA_TYPE",
        details: {
          response,
          expected: selected
            ? [selected]
            : Object.keys(shape.content ?? {}).filter((media) => streamFormat(media)),
          actual,
        },
      })
    if (response.body === null || response.bodyUsed || response.body.locked)
      throw new ClientError("Expected an unused streaming response body", {
        code: "INVALID_RESPONSE_BODY",
        details: { response },
      })
    if (format === "sse") {
      const result = yield* readEvents(response.body, state, signal, owner, maxMessageBytes)
      signal.throwIfAborted()
      if (result.kind === "read-error")
        return { kind: "interrupted", error: result.error, retryAfter: 0 }
    } else if (format === "json-seq")
      yield* readJsonSequence(response.body, signal, owner, maxMessageBytes)
    else yield* readJsonLines(response.body, signal, owner, maxMessageBytes)
    return { kind: "eof" }
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
