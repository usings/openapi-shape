import type { ReaderCancellationSlot } from "../cancellation"
import { bodyReader } from "../cancellation"
import type { StreamMessage } from "../types/stream"
import { MessageBuffer } from "./message-buffer"

/** Only the resume cursor and reconnection time survive a connection. */
export interface SseSessionState {
  lastEventId: string
  reconnectDelayMs: number
}

/** Read failures retain their source; parsing and cancellation still throw their original errors. */
type EventReadResult = { kind: "eof" } | { kind: "read-error"; error: unknown }

/**
 * Parse incrementally, keeping at most the current chunk, line, and event in memory.
 *
 * @yields Each complete event that contains a data field.
 */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
  state: SseSessionState,
  signal: AbortSignal,
  owner?: ReaderCancellationSlot,
  maxMessageBytes = Infinity,
): AsyncGenerator<StreamMessage, EventReadResult> {
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
  let lastEventId = state.lastEventId
  let reconnectDelayMs: number | undefined
  let skipLF = false
  try {
    while (true) {
      signal.throwIfAborted()
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        // oxlint-disable-next-line no-await-in-loop -- stream reads are ordered
        chunk = await reader.read()
      } catch (error) {
        signal.throwIfAborted()
        failed = true
        return { kind: "read-error", error }
      }
      signal.throwIfAborted()
      if (chunk.done) return { kind: "eof" } // An unterminated event is never dispatched.
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
          state.lastEventId = lastEventId
          if (data.length > 0) {
            yield {
              data: data.join("\n"),
              event: event || "message",
              id: lastEventId,
              ...(reconnectDelayMs === undefined ? {} : { retry: reconnectDelayMs }),
            }
            signal.throwIfAborted()
          }
          data = []
          event = ""
          reconnectDelayMs = undefined
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
            if (!value.includes("\0")) lastEventId = value
            break
          case "retry":
            if (/^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value))) {
              reconnectDelayMs = Number(value)
              state.reconnectDelayMs = reconnectDelayMs
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
    await reader.release(failed)
  }
}
