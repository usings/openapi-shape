import type { ReaderCancellationSlot } from "../cancellation"
import type { RequestDispatcher } from "../exchange"
import type { CallInit, RequestDefaults } from "../request"
import type { StreamOptions } from "../types/stream"
import { runStreamSession } from "./session"

/** Adapt one lazy subscription to standard Streams demand and cancellation. */
export function createSubscriptionStream(
  endpoint: string,
  init: CallInit & StreamOptions,
  defaults: RequestDefaults,
  send: RequestDispatcher,
): ReadableStream<unknown> {
  const externalSignal = init.signal
  const abortController = new AbortController()
  let iterator: AsyncGenerator<unknown, void> | undefined
  let terminal = false
  let cleanup: Promise<void> | undefined
  const owner: ReaderCancellationSlot = {}
  let controller: ReadableStreamDefaultController<unknown>
  const dispose = (reason?: unknown): Promise<void> => {
    if (cleanup) return cleanup
    externalSignal?.removeEventListener("abort", abort)
    // Cancel the owned reader first: aborting Fetch can synchronously error its body.
    const bodyCleanup = owner.cancel?.(reason)
    void bodyCleanup?.catch(() => {
      /* Observed by the returned cleanup promise. */
    })
    abortController.abort(reason)
    cleanup = (async () => {
      try {
        await iterator?.return()
      } finally {
        await bodyCleanup
      }
    })()
    return cleanup
  }
  const abort = (): void => {
    if (terminal) return
    terminal = true
    controller.error(externalSignal?.reason)
    void dispose(externalSignal?.reason).catch(() => {
      /* Keep the abort reason. */
    })
  }
  return new ReadableStream<unknown>(
    {
      start(sourceController) {
        controller = sourceController
        if (externalSignal?.aborted) abort()
        else externalSignal?.addEventListener("abort", abort, { once: true })
      },
      async pull() {
        if (terminal) return
        try {
          iterator ??= runStreamSession(
            endpoint,
            init,
            defaults,
            send,
            abortController.signal,
            owner,
          )
          const result = await iterator.next()
          if (terminal) return
          if (result.done) {
            terminal = true
            controller.close()
            externalSignal?.removeEventListener("abort", abort)
          } else controller.enqueue(result.value)
        } catch (error) {
          if (terminal) return
          terminal = true
          controller.error(error)
          await dispose(error).catch(() => {
            /* Keep the stream failure. */
          })
        }
      },
      cancel(reason) {
        terminal = true
        return dispose(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
