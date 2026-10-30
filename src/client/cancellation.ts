/** Await user/transport work without requiring it to honor cancellation. */
export function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

/** Cleanup cannot replace a subscription's error or cancellation reason. */
export function cancelBody(response: Response, reason?: unknown): void {
  void response.body?.cancel(reason).catch(() => {
    /* A parser may already have closed or canceled the body. */
  })
}

/** Split intervals above the JavaScript timer limit instead of overflowing to an immediate retry. */
export async function wait(delay: number, signal: AbortSignal): Promise<void> {
  let remaining = delay
  do {
    signal.throwIfAborted()
    const interval = Math.min(remaining, 2_147_483_647)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // oxlint-disable-next-line no-await-in-loop -- a long interval is a sequence of safe waits
      await raceWithAbort(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, interval)
        }),
        signal,
      )
    } finally {
      clearTimeout(timer)
    }
    remaining -= interval
  } while (remaining > 0)
}

/** The subscription can cancel its currently owned reader before aborting the transport. */
export interface BodyOwner {
  cancel?: ((reason?: unknown) => Promise<void>) | undefined
}

/** A parser owns one reader and propagates its cancellation and cleanup to the subscription. */
export function bodyReader(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  owner?: BodyOwner,
) {
  const reader = body.getReader()
  let completed = false
  let cancellation: Promise<void> | undefined
  const cancel = (reason?: unknown): Promise<void> => {
    if (!cancellation) {
      cancellation = reader.cancel(reason)
      void cancellation.catch(() => {
        // Observed again by release and by the subscription's explicit cancel.
      })
    }
    return cancellation
  }
  if (owner) owner.cancel = cancel
  const abort = (): void => {
    void cancel(signal.reason)
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const release = async (): Promise<void> => {
    signal.removeEventListener("abort", abort)
    if (owner?.cancel === cancel) owner.cancel = undefined
    try {
      if (!completed || cancellation) await cancel(signal.aborted ? signal.reason : undefined)
    } finally {
      reader.releaseLock()
    }
  }
  return {
    async read() {
      const result = await reader.read()
      completed = result.done
      return result
    },
    /** Normal completion awaits cleanup; failure cleanup cannot delay or replace the original error. */
    async release(failed = false) {
      const pending = release()
      if (failed) {
        void pending.catch(() => {
          /* Keep the original failure even when cleanup rejects. */
        })
      } else await pending
    },
  }
}
