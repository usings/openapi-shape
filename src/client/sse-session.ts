import type { EventState } from "./sse"
import { wait } from "./stream-lifecycle"

/**
 * Additional SSE connections allowed over the whole subscription, with a configurable initial
 * delay.
 */
export interface StreamRetryOptions {
  delay?: number
  maxRetries?: number
}

/** An internal connection failure carrying the original public error. */
export class RetryableStreamError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly retryAfter = 0,
  ) {
    super("SSE connection interrupted", { cause })
  }
}

/** A connection returns true only for an explicit server stop (HTTP 204). */
type Connect = () => AsyncGenerator<unknown, boolean>

/**
 * Reconnect sequentially within the same demand for an event; never run ahead of the consumer.
 *
 * @yields Events from sequential SSE connections.
 */
export async function* sseSession(
  connect: Connect,
  state: EventState,
  retry: false | StreamRetryOptions | undefined,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const maxRetries = retry === false ? 0 : (retry?.maxRetries ?? Infinity)
  let retries = 0
  while (true) {
    signal.throwIfAborted()
    let delay = 0
    try {
      if (yield* connect()) return
      // Normal EOF is not an error: once the reconnect budget ends, close normally.
      if (retries >= maxRetries) return
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof RetryableStreamError)) throw error
      if (retries >= maxRetries) throw error.cause
      delay = error.retryAfter
    }
    retries++
    // oxlint-disable-next-line no-await-in-loop -- one subscription owns one ordered retry wait
    await wait(Math.max(state.retry, delay), signal)
  }
}

/** Only a safe integer interval can be represented exactly by the parser and timer. */
export function validateRetry(retry: false | StreamRetryOptions | undefined): number {
  if (retry !== undefined && retry !== false && (retry === null || typeof retry !== "object"))
    throw new TypeError("SSE retry must be false or an options object")
  const delay = retry === false ? 1000 : (retry?.delay ?? 1000)
  const maxRetries = retry === false ? undefined : retry?.maxRetries
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
