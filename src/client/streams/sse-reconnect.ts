import { wait } from "../cancellation"
import type { ReconnectOptions } from "../types/stream"
import type { SseSessionState } from "./parser-sse"

/** A connection ends normally, stops explicitly, or is interrupted by a recoverable failure. */
export type StreamConnectionOutcome =
  | { kind: "eof" }
  | { kind: "stop" }
  | { kind: "interrupted"; error: unknown; retryAfter: number }

type Connect = () => AsyncGenerator<unknown, StreamConnectionOutcome>

/**
 * Reconnect sequentially within the same demand for an event; never run ahead of the consumer.
 *
 * @yields Events from sequential SSE connections.
 */
export async function* reconnectSSE(
  connect: Connect,
  state: SseSessionState,
  policy: SseReconnectPolicy,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  let attempts = 0
  while (true) {
    signal.throwIfAborted()
    attempts++
    const result = yield* connect()
    signal.throwIfAborted()
    if (result.kind === "stop") return
    if (attempts >= policy.maxAttempts) {
      if (result.kind === "interrupted") throw result.error
      return
    }
    const delay = result.kind === "interrupted" ? result.retryAfter : 0
    // oxlint-disable-next-line no-await-in-loop -- one subscription owns one ordered reconnect wait
    await wait(Math.max(state.reconnectDelayMs, delay), signal)
  }
}

/** Only a safe integer interval can be represented exactly by the parser and timer. */
interface SseReconnectPolicy {
  maxAttempts: number
  initialDelayMs: number
  replay: boolean
}

export function resolveSseReconnectPolicy(
  reconnect: boolean | ReconnectOptions | undefined,
): SseReconnectPolicy {
  if (
    reconnect !== undefined &&
    typeof reconnect !== "boolean" &&
    (reconnect === null || typeof reconnect !== "object")
  )
    throw new TypeError("SSE reconnect must be a boolean or an options object")
  const delay = typeof reconnect === "boolean" ? 1000 : (reconnect?.delay ?? 1000)
  const maxAttempts = typeof reconnect === "boolean" ? undefined : reconnect?.maxAttempts
  if (!Number.isSafeInteger(delay) || delay < 0)
    throw new TypeError("SSE reconnect delay must be a non-negative safe integer")
  if (maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1))
    throw new TypeError("SSE maxAttempts must be a positive safe integer")
  const attempts =
    reconnect === undefined || reconnect === false
      ? 1
      : reconnect === true
        ? Infinity
        : (maxAttempts ?? Infinity)
  return { maxAttempts: attempts, initialDelayMs: delay, replay: attempts > 1 }
}

/** Retry-After affects only this attempt, not the subscription's SSE reconnection interval. */
export function retryAfterDelay(response: Response): number {
  const value = response.headers.get("retry-after")
  if (value === null) return 0
  if (/^[0-9]+$/.test(value)) {
    const delay = Number(value) * 1000
    return Number.isSafeInteger(delay) ? delay : 0
  }
  // HTTP-date permits IMF-fixdate and the two obsolete weekday-prefixed forms.
  if (
    !/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)(?:, | )/.test(
      value,
    )
  )
    return 0
  // The asctime form has no timezone suffix, but HTTP-date always means GMT.
  const time = Date.parse(value.endsWith("GMT") ? value : `${value} GMT`)
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : 0
}
