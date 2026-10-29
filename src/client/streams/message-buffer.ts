/** A single parsed message exceeded the caller's byte budget. */
export class StreamMessageTooLargeError extends RangeError {
  constructor(
    readonly maxMessageBytes: number,
    readonly receivedBytes: number,
  ) {
    super(`Stream message exceeds maxMessageBytes (${maxMessageBytes} bytes)`)
    this.name = "StreamMessageTooLargeError"
  }
}

/** An omitted limit leaves records unbounded; explicit limits must be positive safe integers. */
export function messageLimit(value: number | undefined): number {
  if (value === undefined) return Infinity
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError("maxMessageBytes must be a positive safe integer")
  return value
}

/** Retain only the current record (or SSE line), checking before buffering or joining bytes. */
export class MessageBuffer {
  private parts: Uint8Array[] = []
  private size = 0

  constructor(private readonly limit: number) {}

  get byteLength(): number {
    return this.size
  }

  /** Earlier SSE field lines share the current line's message budget. */
  append(bytes: Uint8Array, precedingBytes = 0): void {
    if (bytes.byteLength === 0) return
    const receivedBytes = precedingBytes + this.size + bytes.byteLength
    if (receivedBytes > this.limit) throw new StreamMessageTooLargeError(this.limit, receivedBytes)
    this.parts.push(bytes)
    this.size += bytes.byteLength
  }

  take(): Uint8Array {
    const parts = this.parts
    const size = this.size
    this.parts = []
    this.size = 0
    const only = parts.at(0)
    if (parts.length === 1 && only !== undefined) return only
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    return bytes
  }
}
