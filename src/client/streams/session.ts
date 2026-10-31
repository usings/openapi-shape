import type { EndpointContract } from "../../shared/contract"
import { streamFormat } from "../../shared/media"
import type { ReaderCancellationSlot } from "../cancellation"
import { cancelBody } from "../cancellation"
import { ClientError } from "../errors"
import type { RequestDispatcher } from "../exchange"
import { mergeHeaders } from "../headers"
import { matchDeclaredMedia, responseContentType } from "../media"
import type { MiddlewareContext } from "../middleware"
import type { CallInit, RequestDefaults } from "../request"
import { buildRequest } from "../request"
import { resolveResponseDeclaration } from "../response"
import type { StreamOptions } from "../types/stream"
import { isStream } from "../values"
import { snapshotRequestBody } from "./body-snapshot"
import { messageLimit } from "./message-buffer"
import { readJsonSequence } from "./parser-json-seq"
import { readJsonLines } from "./parser-jsonl"
import type { SseSessionState } from "./parser-sse"
import { readEvents } from "./parser-sse"
import type { StreamConnectionOutcome } from "./sse-reconnect"
import { retryAfterDelay, reconnectSSE, resolveSseReconnectPolicy } from "./sse-reconnect"

/**
 * Send once without buffering, or snapshot a replayable body when SSE reconnection is enabled.
 *
 * @yields Parsed items of the selected response representation.
 */
export async function* runStreamSession(
  endpoint: string,
  init: CallInit & StreamOptions,
  defaults: RequestDefaults,
  send: RequestDispatcher,
  signal: AbortSignal,
  owner: ReaderCancellationSlot,
): AsyncGenerator<unknown, void> {
  signal.throwIfAborted()
  const media = Object.hasOwn(defaults.endpoints, endpoint)
    ? defaults.endpoints[endpoint] &&
      collectStreamMedia(defaults.endpoints[endpoint], endpoint.split(" ")[0])
    : undefined
  if (!media?.length)
    throw new TypeError(`Endpoint "${endpoint}" does not declare a successful streaming response`)
  const { reconnect, maxMessageBytes: configuredMaxMessageBytes, ...call } = init
  const selectionHeaders = mergeHeaders(
    defaults.headers,
    init.headers,
    defaults.endpoints[endpoint]?.parameters?.header,
  )
  const accept = selectionHeaders.get("accept") ?? undefined
  const maxMessageBytes = messageLimit(configuredMaxMessageBytes)
  const selected =
    accept && media.includes(accept)
      ? accept
      : accept === undefined && media.length === 1
        ? media[0]
        : undefined
  const format = selected ? streamFormat(selected) : undefined
  if (format !== "sse" && reconnect !== undefined && reconnect !== false)
    throw new TypeError("Automatic reconnect requires a single SSE media selection")
  const policy = resolveSseReconnectPolicy(format === "sse" ? reconnect : false)
  const replay = policy.replay
  if (replay && isStream(call.body))
    throw new TypeError(
      "SSE reconnection cannot replay a streaming request body; set reconnect: false",
    )
  const state: SseSessionState = {
    lastEventId: "",
    reconnectDelayMs: policy.initialDelayMs,
  }
  const template = buildRequest(endpoint, { ...call, signal }, defaults, selectionHeaders)
  const replayBodyBytes =
    !replay || template.body === null
      ? undefined
      : await snapshotRequestBody(template.body, signal, owner)
  if (!accept) template.headers.set("accept", selected ?? media.join(", "))
  const headers = replay ? new Headers(template.headers) : template.headers
  const initialLastEventId = headers.get("last-event-id") ?? ""
  state.lastEventId = new TextDecoder().decode(
    Uint8Array.from(initialLastEventId, (char) => char.charCodeAt(0)),
  )
  const context: MiddlewareContext = { endpoint, kind: "stream" }
  let first = true
  const connect = (): AsyncGenerator<unknown, StreamConnectionOutcome> => {
    const attemptHeaders = replay ? new Headers(headers) : headers
    if (format === "sse" && !first) {
      if (state.lastEventId) attemptHeaders.set("last-event-id", headerId(state.lastEventId))
      else attemptHeaders.delete("last-event-id")
    }
    first = false
    const request = replay
      ? new Request(template, {
          headers: attemptHeaders,
          ...(replayBodyBytes === undefined ? {} : { body: replayBodyBytes }),
        })
      : template
    return runStreamConnection(
      request,
      selected,
      state,
      send,
      context,
      signal,
      owner,
      maxMessageBytes,
      defaults.endpoints[endpoint],
    )
  }
  if (format === "sse") yield* reconnectSSE(connect, state, policy, signal)
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
async function* runStreamConnection(
  request: Request,
  selected: string | undefined,
  state: SseSessionState,
  send: RequestDispatcher,
  context: MiddlewareContext,
  signal: AbortSignal,
  owner: ReaderCancellationSlot,
  maxMessageBytes: number,
  endpointDeclaration?: EndpointContract,
): AsyncGenerator<unknown, StreamConnectionOutcome> {
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
    const responseDeclaration =
      endpointDeclaration && resolveResponseDeclaration(endpointDeclaration, response.status)
    if (!responseDeclaration)
      throw new ClientError("Response status is not declared by this operation", {
        code: "UNDECLARED_STATUS",
        details: { response },
      })
    const actual = responseContentType(response.headers)
    const matched =
      actual &&
      responseDeclaration.content &&
      matchDeclaredMedia(responseDeclaration.content, actual)
    const format = matched ? streamFormat(matched) : undefined
    if (!format || (selected !== undefined && matched !== selected))
      throw new ClientError("Response media does not match a declared streaming representation", {
        code: "UNEXPECTED_MEDIA_TYPE",
        details: {
          response,
          expected: selected
            ? [selected]
            : Object.keys(responseDeclaration.content ?? {}).filter((media) => streamFormat(media)),
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
    const responseDeclaration = resolveResponseDeclaration(endpoint, status)
    if (responseDeclaration) effective.add(responseDeclaration)
  }
  return [
    ...new Set(
      Object.values(endpoint.responses).flatMap((responseDeclaration) =>
        effective.has(responseDeclaration)
          ? Object.keys(responseDeclaration.content ?? {}).filter((key) => streamFormat(key))
          : [],
      ),
    ),
  ]
}
