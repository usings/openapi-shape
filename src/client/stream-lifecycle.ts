/** Await user/transport work without requiring it to honor cancellation. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
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
export function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {
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
      await abortable(
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
