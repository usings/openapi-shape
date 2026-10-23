import { isStream } from "./body"
import type { CallInit, RequestDefaults } from "./request"
import { buildRequest } from "./request"
import type { StreamMessage } from "./sse"
import { readEvents } from "./sse"
import { mediaTypeEssence } from "./values"

export type { StreamMessage } from "./sse"

/** Lifecycle hooks are awaited in order. Returning a delay explicitly opts into retrying. */
export interface StreamOptions<Message = StreamMessage> {
  onOpen?: (response: Response) => void | Promise<void>
  onMessage?: (message: Message) => void | Promise<void>
  onClose?: () => void | Promise<void>
  /** Undefined uses the default policy; false stops with the error; a number retries in ms. */
  onError?: (error: unknown) => number | false | void | Promise<number | false | void>
}

/** A refused stream response. Its status and headers remain available after its body is canceled. */
export class StreamResponseError extends Error {
  constructor(
    message: string,
    readonly response: Response,
  ) {
    super(message)
    this.name = "StreamResponseError"
  }
}

type Send = (request: Request) => Promise<Response>

/** One subscription owns one connection at a time, including its retry waits. */
export async function stream(
  endpoint: string,
  init: CallInit & StreamOptions,
  defaults: RequestDefaults,
  send: Send,
): Promise<void> {
  const { onOpen, onMessage, onClose, onError, ...call } = init
  if (defaults.endpoints[endpoint]?.stream !== "sse") {
    throw new TypeError(`Endpoint "${endpoint}" does not declare a successful SSE response`)
  }
  call.signal?.throwIfAborted()
  if (isStream(call.body)) throw new TypeError("api.stream cannot replay a streaming request body")
  const controller = new AbortController()
  const signal = controller.signal
  const abort = (): void => {
    controller.abort(call.signal?.reason)
  }
  call.signal?.addEventListener("abort", abort, { once: true })
  try {
    const template = buildRequest(endpoint, { ...call, signal }, defaults)
    // Consume once before sending: no Request.clone/tee with an unread, growing branch.
    const body =
      template.body === null ? undefined : await abortable(template.arrayBuffer(), signal)
    const headers = new Headers(template.headers)
    if (!headers.has("accept")) headers.set("accept", "text/event-stream")
    const initialId = headers.get("last-event-id") ?? ""
    const state = {
      id: new TextDecoder().decode(Uint8Array.from(initialId, (char) => char.charCodeAt(0))),
      retry: 1000,
    }
    while (true) {
      signal.throwIfAborted()
      if (state.id) headers.set("last-event-id", headerId(state.id))
      else headers.delete("last-event-id")
      const request = new Request(template, { headers, ...(body === undefined ? {} : { body }) })
      let response: Response | undefined
      let retryable = true
      try {
        // The transport may ignore abort. Dispose even a response that arrives after cancellation.
        const pending = send(request).then((received) => {
          response = received
          if (signal.aborted) cancelBody(received)
          return received
        })
        // oxlint-disable-next-line no-await-in-loop -- attempts cannot overlap
        response = await abortable(pending, signal)
        retryable = false
        if (response.status === 204) {
          // oxlint-disable-next-line no-await-in-loop -- lifecycle callbacks are ordered
          await abortable(Promise.resolve(onClose?.()), signal)
          return
        }
        if (!response.ok) {
          retryable = response.status === 408 || response.status === 429 || response.status >= 500
          throw new StreamResponseError(
            `SSE request failed with status ${response.status}`,
            response,
          )
        }
        if (
          mediaTypeEssence(response.headers.get("content-type") ?? "") !== "text/event-stream" ||
          response.body === null
        ) {
          throw new StreamResponseError(
            "Expected a text/event-stream response with a body",
            response,
          )
        }
        // oxlint-disable-next-line no-await-in-loop -- lifecycle callbacks are ordered
        await abortable(Promise.resolve(onOpen?.(response)), signal)
        retryable = true
        // oxlint-disable-next-line no-await-in-loop -- read each event before delivering the next
        for await (const message of readEvents(response.body, state, signal)) {
          retryable = false
          // oxlint-disable-next-line no-await-in-loop -- await consumers to apply backpressure
          await abortable(Promise.resolve(onMessage?.(message)), signal)
          retryable = true
        }
        retryable = false
        // oxlint-disable-next-line no-await-in-loop -- lifecycle callbacks are ordered
        await abortable(Promise.resolve(onClose?.()), signal)
        return
      } catch (error) {
        signal.throwIfAborted()
        // Release this connection before invoking user code or waiting for another attempt.
        if (response) cancelBody(response)
        // oxlint-disable-next-line no-await-in-loop -- retry policy belongs to this failed attempt
        const decision = await abortable(Promise.resolve(onError?.(error)), signal)
        if (decision === false || (decision === undefined && !retryable)) throw error
        const delay = decision === undefined ? state.retry : decision
        if (!Number.isFinite(delay) || delay < 0)
          throw new TypeError("SSE retry delay must be a finite, non-negative number", {
            cause: error,
          })
        // oxlint-disable-next-line no-await-in-loop -- wait before the next connection
        await wait(delay, signal)
      } finally {
        if (response) cancelBody(response)
      }
    }
  } finally {
    call.signal?.removeEventListener("abort", abort)
    controller.abort()
  }
}

/** Fetch headers take byte strings; SSE resume IDs are UTF-8 encoded on the wire. */
function headerId(id: string): string {
  let value = ""
  for (const byte of new TextEncoder().encode(id)) value += String.fromCharCode(byte)
  return value
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {
    /* Cleanup must not mask the original error. */
  })
}

/** Cancel pending user/transport promises without waiting for them to honor the signal. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

async function wait(delay: number, signal: AbortSignal): Promise<void> {
  // JS timers overflow above this limit; split long server-provided intervals into safe waits.
  let remaining = delay
  do {
    signal.throwIfAborted()
    const interval = Math.min(remaining, 2_147_483_647)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // oxlint-disable-next-line no-await-in-loop -- long delays are split into consecutive waits
      await abortable(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, interval)
        }),
        signal,
      )
    } finally {
      clearTimeout(timer)
    }
    remaining -= interval
  } while (remaining > 0)
}
