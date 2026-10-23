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

/**
 * Parse incrementally, keeping at most the current chunk, line, and event in memory.
 *
 * @yields Each complete event that contains a data field.
 */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
  state: EventState,
  signal: AbortSignal,
): AsyncGenerator<StreamMessage> {
  const reader = body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => {
      /* Cleanup must not mask the original error. */
    })
  }
  signal.addEventListener("abort", cancel, { once: true })
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
      // oxlint-disable-next-line no-await-in-loop -- stream reads are ordered
      const chunk = await reader.read()
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
  } finally {
    signal.removeEventListener("abort", cancel)
    // Cancellation errors cannot replace the original stream or callback error.
    void reader.cancel().catch(() => {
      /* Cleanup must not mask the original error. */
    })
    reader.releaseLock()
  }
}
