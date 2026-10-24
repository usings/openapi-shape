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
): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => {
      /* Preserve the subscription's cancellation reason. */
    })
  }
  signal.addEventListener("abort", cancel, { once: true })
  // Preserve BOM so JSON.parse rejects it; do not replace malformed UTF-8 with different data.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  let fragments: Uint8Array[] = []
  let line = 1
  const parse = (): unknown => {
    const size = fragments.reduce((length, part) => length + part.length, 0)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of fragments) {
      bytes.set(part, offset)
      offset += part.length
    }
    fragments = []
    try {
      return JSON.parse(decoder.decode(bytes))
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
        if (fragments.length > 0) yield parse()
        return
      }
      let start = 0
      const bytes = chunk.value
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue
        fragments.push(bytes.subarray(start, i))
        start = i + 1
        yield parse()
        signal.throwIfAborted()
        line++
      }
      if (start < bytes.length) fragments.push(bytes.subarray(start))
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    void reader.cancel().catch(() => {
      /* Cleanup cannot mask a decoding or transport failure. */
    })
    reader.releaseLock()
  }
}
