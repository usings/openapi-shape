import type { BodyOwner } from "../cancellation"
import { bodyReader } from "../cancellation"
import { MessageBuffer } from "./message-buffer"

/**
 * Decode RFC 7464 records on demand, recovering at RS after malformed or truncated JSON.
 *
 * @yields Each complete JSON value in response order.
 */
export async function* readJsonSequence(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  owner?: BodyOwner,
  maxMessageBytes = Infinity,
): AsyncGenerator<unknown> {
  const reader = bodyReader(body, signal, owner)
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const buffer = new MessageBuffer(maxMessageBytes)
  let active = false
  let started = false
  let quoted = false
  let escaped = false
  let depth = 0
  let failed = false
  const parse = (terminated = false): [] | [unknown] => {
    try {
      const text = decoder.decode(buffer.take())
      const value: unknown = JSON.parse(text)
      // Numbers and literal values need trailing JSON whitespace to rule out truncation.
      if (
        (value === null || typeof value === "number" || typeof value === "boolean") &&
        !terminated &&
        !/[\x20\t\r\n]$/.test(text)
      )
        return []
      return [value]
    } catch {
      return []
    }
  }
  try {
    while (true) {
      signal.throwIfAborted()
      // oxlint-disable-next-line no-await-in-loop -- records follow the response byte order
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        if (active) yield* parse()
        return
      }
      const bytes = chunk.value
      let start = 0
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i]
        if (byte === 30) {
          if (active) buffer.append(bytes.subarray(start, i))
          const result = active ? parse() : []
          active = true
          started = false
          quoted = false
          escaped = false
          depth = 0
          start = i + 1
          yield* result
          signal.throwIfAborted()
          continue
        }
        if (!active) continue
        if (quoted) {
          if (escaped) escaped = false
          else if (byte === 92) escaped = true
          else if (byte === 34) quoted = false
        } else if (byte === 34) quoted = true
        else if (byte === 123 || byte === 91) depth++
        else if (byte === 125 || byte === 93) depth--
        if (byte !== 32 && byte !== 9 && byte !== 13 && byte !== 10) started = true
        // A top-level LF finishes a record without waiting for another RS or EOF.
        if (byte === 10 && started && !quoted && depth === 0) {
          buffer.append(bytes.subarray(start, i))
          active = false
          yield* parse(true)
          signal.throwIfAborted()
        }
      }
      if (active) buffer.append(bytes.subarray(start))
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    const released = reader.release()
    if (failed) {
      void released.catch(() => {
        /* Cleanup cannot delay or replace a transport failure. */
      })
    } else await released
  }
}
