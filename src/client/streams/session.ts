import { wait } from "../cancellation"
import type { StreamRetryOptions } from "../types/stream"
import type { EventState } from "./parser-sse"

/** A connection ends normally, stops explicitly, or is interrupted by a recoverable failure. */
export type ConnectionResult =
  | { kind: "eof" }
  | { kind: "stop" }
  | { kind: "interrupted"; error: unknown; retryAfter: number }

type Connect = () => AsyncGenerator<unknown, ConnectionResult>

/**
 * Reconnect sequentially within the same demand for an event; never run ahead of the consumer.
 *
 * @yields Events from sequential SSE connections.
 */
export async function* streamSession(
  connect: Connect,
  state: EventState,
  retry: boolean | StreamRetryOptions | undefined,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const maxRetries =
    retry === undefined || retry === false
      ? 0
      : retry === true
        ? Infinity
        : (retry.maxRetries ?? Infinity)
  let retries = 0
  while (true) {
    signal.throwIfAborted()
    const result = yield* connect()
    signal.throwIfAborted()
    if (result.kind === "stop") return
    if (retries >= maxRetries) {
      if (result.kind === "interrupted") throw result.error
      return
    }
    const delay = result.kind === "interrupted" ? result.retryAfter : 0
    retries++
    // oxlint-disable-next-line no-await-in-loop -- one subscription owns one ordered retry wait
    await wait(Math.max(state.retry, delay), signal)
  }
}

/** Only a safe integer interval can be represented exactly by the parser and timer. */
export function validateRetry(retry: boolean | StreamRetryOptions | undefined): number {
  if (
    retry !== undefined &&
    typeof retry !== "boolean" &&
    (retry === null || typeof retry !== "object")
  )
    throw new TypeError("SSE retry must be a boolean or an options object")
  const delay = typeof retry === "boolean" ? 1000 : (retry?.delay ?? 1000)
  const maxRetries = typeof retry === "boolean" ? undefined : retry?.maxRetries
  if (!Number.isSafeInteger(delay) || delay < 0)
    throw new TypeError("SSE retry delay must be a non-negative safe integer")
  if (maxRetries !== undefined && (!Number.isSafeInteger(maxRetries) || maxRetries < 0))
    throw new TypeError("SSE maxRetries must be a non-negative safe integer")
  return delay
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
