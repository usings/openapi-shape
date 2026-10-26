import type { BodyOwner } from "./cancellation"
import { bodyReader } from "./cancellation"

/** One dispatched SSE event. Data is text, even when it contains JSON. */
export interface StreamMessage {
  data: string
  event: string
  id: string
  retry?: number
}

/** Only the resume cursor and reconnection time survive a connection. */
export interface EventState {
  id: string
  retry: number
}

/** Only a failed body read is eligible for reconnect; parser errors keep their own identity. */
export class StreamReadError extends Error {
  constructor(override readonly cause: unknown) {
    super("Failed to read the SSE response", { cause })
  }
}

/**
 * Parse incrementally, keeping at most the current chunk, line, and event in memory.
 *
 * @yields Each complete event that contains a data field.
 */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
  state: EventState,
  signal: AbortSignal,
  owner?: BodyOwner,
): AsyncGenerator<StreamMessage> {
  const reader = bodyReader(body, signal, owner)
  let failed = false
  const decoder = new TextDecoder()
  let fragments: string[] = []
  let data: string[] = []
  let event = ""
  let id = state.id
  let retry: number | undefined
  let skipLF = false
  try {
    while (true) {
      signal.throwIfAborted()
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        // oxlint-disable-next-line no-await-in-loop -- stream reads are ordered
        chunk = await reader.read()
      } catch (error) {
        throw new StreamReadError(error)
      }
      signal.throwIfAborted()
      if (chunk.done) return // An unterminated event is never dispatched.
      const text = decoder.decode(chunk.value, { stream: true })
      let start = 0
      for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (skipLF) {
          skipLF = false
          if (char === "\n") {
            start = i + 1
            continue
          }
        }
        if (char !== "\r" && char !== "\n") continue
        skipLF = char === "\r"
        fragments.push(text.slice(start, i))
        const line = fragments.join("")
        fragments = []
        start = i + 1
        if (line === "") {
          state.id = id
          if (data.length > 0) {
            yield {
              data: data.join("\n"),
              event: event || "message",
              id,
              ...(retry === undefined ? {} : { retry }),
            }
            signal.throwIfAborted()
          }
          data = []
          event = ""
          retry = undefined
          continue
        }
        const colon = line.indexOf(":")
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? "" : line.slice(colon + 1)
        if (value.startsWith(" ")) value = value.slice(1)
        switch (field) {
          case "data":
            data.push(value)
            break
          case "event":
            event = value
            break
          case "id":
            if (!value.includes("\0")) id = value
            break
          case "retry":
            if (/^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value))) {
              retry = Number(value)
              state.retry = retry
            }
            break
          default:
            break
        }
      }
      if (start < text.length) fragments.push(text.slice(start))
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    const released = reader.release()
    if (failed) {
      void released.catch(() => {
        /* Cleanup cannot delay or replace a parser failure. */
      })
    } else await released
  }
}
