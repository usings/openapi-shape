import { raceWithAbort, cancelBody } from "./cancellation"
import type { Fetcher, Middleware, MiddlewareContext } from "./middleware"

/** Observe only transport failures, without wrapping errors seen by middleware or callers. */
export type RequestDispatcher = (
  request: Request,
  context: MiddlewareContext,
  transportFailed?: (error: unknown) => void,
) => Promise<Response>

interface Exchange {
  context: MiddlewareContext
  signal: AbortSignal
  transportFailed: ((error: unknown) => void) | undefined
}

type Dispatch = (request: Request, exchange: Exchange) => Promise<Response>

/** Compile the chain once; each boundary owns a response only until it hands it off. */
export function createRequestDispatcher(
  middleware: readonly Middleware[],
  transport?: Fetcher,
): RequestDispatcher {
  const transmit: Dispatch = async (request, exchange) => {
    exchange.signal.throwIfAborted()
    let response: Response
    try {
      // Called unbound: browser fetch implementations can reject a different receiver.
      response = await (transport ?? globalThis.fetch)(request)
    } catch (error) {
      exchange.transportFailed?.(error)
      throw error
    }
    return response
  }
  const dispatch = middleware.reduceRight<Dispatch>(
    (next, wrap) => async (request, exchange) => {
      exchange.signal.throwIfAborted()
      return await wrap(
        request,
        (outgoing) => handoff(next(outgoing, exchange), exchange.signal),
        exchange.context,
      )
    },
    transmit,
  )
  return async (request, context, transportFailed) => {
    request.signal.throwIfAborted()
    return await handoff(
      dispatch(request, {
        context: Object.freeze({ ...context }),
        signal: request.signal,
        transportFailed,
      }),
      request.signal,
    )
  }
}

/** Retire a response only when cancellation prevents delivery across this boundary. */
async function handoff(pending: Promise<Response>, signal: AbortSignal): Promise<Response> {
  let received: Response | undefined
  let finished = false
  let delivered = false
  const observed = pending.then((response) => {
    received = response
    if (finished) cancelBody(response, signal.reason)
    return response
  })
  try {
    const response = await raceWithAbort(observed, signal)
    signal.throwIfAborted()
    delivered = true
    return response
  } finally {
    finished = true
    if (!delivered && received) cancelBody(received, signal.reason)
  }
}
