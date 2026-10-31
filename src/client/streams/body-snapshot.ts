import type { ReaderCancellationSlot } from "../cancellation"
import { bodyReader, raceWithAbort } from "../cancellation"

/** Own the encoded body only while capturing bytes for subsequent SSE attempts. */
export async function snapshotRequestBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  owner: ReaderCancellationSlot,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = bodyReader(body, signal, owner)
  let failed = false
  try {
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      signal.throwIfAborted()
      // oxlint-disable-next-line no-await-in-loop -- capture the encoded body in wire order
      const chunk = await raceWithAbort(reader.read(), signal)
      signal.throwIfAborted()
      if (chunk.done) break
      chunks.push(new Uint8Array(chunk.value))
      length += chunk.value.byteLength
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } catch (error) {
    failed = true
    throw error
  } finally {
    await reader.release(failed)
  }
}
