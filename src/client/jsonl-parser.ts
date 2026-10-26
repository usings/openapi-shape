import type { BodyOwner } from "./cancellation"
import { bodyReader } from "./cancellation"
import { MessageBuffer } from "./message-buffer"

/** A malformed JSON line; line is one-based and input contents are never embedded in the message. */
export class StreamParseError extends SyntaxError {
  constructor(
    readonly line: number,
    cause: unknown,
  ) {
    super(`Invalid JSON stream record at line ${line}`, { cause })
    this.name = "StreamParseError"
  }
}

/**
 * Decode one record on demand, allowing a valid final record without a trailing newline.
 *
 * @yields Each parsed JSON value in response order.
 */
export async function* readJsonLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  owner?: BodyOwner,
  maxMessageBytes = Infinity,
): AsyncGenerator<unknown> {
  const reader = bodyReader(body, signal, owner)
  let failed = false
  // Preserve BOM so JSON.parse rejects it; do not replace malformed UTF-8 with different data.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const buffer = new MessageBuffer(maxMessageBytes)
  let line = 1
  const parse = (): unknown => {
    try {
      return JSON.parse(decoder.decode(buffer.take()))
    } catch (error) {
      throw new StreamParseError(line, error)
    }
  }
  try {
    while (true) {
      signal.throwIfAborted()
      // oxlint-disable-next-line no-await-in-loop -- records follow the response byte order
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        if (buffer.byteLength > 0) yield parse()
        return
      }
      let start = 0
      const bytes = chunk.value
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue
        buffer.append(bytes.subarray(start, i))
        start = i + 1
        yield parse()
        signal.throwIfAborted()
        line++
      }
      buffer.append(bytes.subarray(start))
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
