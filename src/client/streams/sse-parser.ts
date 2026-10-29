import type { BodyOwner } from "../cancellation"
import { bodyReader } from "../cancellation"
import { MessageBuffer } from "./message-buffer"

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
  maxMessageBytes = Infinity,
): AsyncGenerator<StreamMessage> {
  const reader = bodyReader(body, signal, owner)
  let failed = false
  // Decode complete lines so limits are checked on raw bytes before allocating strings.
  // Preserve BOMs here and strip only the one at the start of the connection.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
  const buffer = new MessageBuffer(maxMessageBytes)
  let firstLine = true
  let messageBytes = 0
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
      const bytes = chunk.value
      let start = 0
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i]
        if (skipLF) {
          skipLF = false
          if (byte === 10) {
            start = i + 1
            continue
          }
        }
        if (byte !== 13 && byte !== 10) continue
        skipLF = byte === 13
        buffer.append(bytes.subarray(start, i), messageBytes)
        const lineBytes = buffer.byteLength
        let line = decoder.decode(buffer.take())
        if (firstLine) {
          firstLine = false
          if (line.startsWith("\uFEFF")) line = line.slice(1)
        }
        start = i + 1
        if (line === "") {
          messageBytes = 0
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
        // Heartbeats are discarded once their line is complete, even without a blank block.
        if (line.startsWith(":")) continue
        messageBytes += lineBytes
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
      buffer.append(bytes.subarray(start), messageBytes)
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
