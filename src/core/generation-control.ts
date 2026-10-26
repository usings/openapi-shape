import { setImmediate } from "node:timers/promises"

/** Cancellation and cooperative scheduling shared by the stages of one generation. */
export class GenerationControl {
  private lastYield = performance.now()

  constructor(readonly signal?: AbortSignal) {}

  throwIfAborted(): void {
    this.signal?.throwIfAborted()
  }

  /** Let a pending abort, such as a timeout, fire between synchronous generation stages. */
  async checkpoint(): Promise<void> {
    if (this.signal === undefined) return
    await setImmediate()
    this.signal.throwIfAborted()
    this.lastYield = performance.now()
  }

  /** Yield between synchronous work units after a short time slice, only for cancellable runs. */
  workpoint(): Promise<void> | undefined {
    if (this.signal === undefined) return undefined
    this.throwIfAborted()
    return performance.now() - this.lastYield >= 8 ? this.checkpoint() : undefined
  }
}
