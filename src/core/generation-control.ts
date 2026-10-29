import { setImmediate } from "node:timers/promises"

/** Cancellation and cooperative scheduling shared by the stages of one generation. */
export class GenerationControl {
  private units = 0
  private lastYield = performance.now()

  constructor(readonly signal?: AbortSignal) {}

  throwIfAborted(): void {
    this.signal?.throwIfAborted()
  }

  /** Bound semantic compilation work independently from retrieval rounds and call-stack depth. */
  consume(): void {
    this.throwIfAborted()
    if (++this.units > 1_000_000) throw new GenerationLimitError()
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

export class GenerationLimitError extends Error {
  constructor() {
    super("The description exceeds the semantic work budget of 1,000,000 nodes")
    this.name = "GenerationLimitError"
  }
}
