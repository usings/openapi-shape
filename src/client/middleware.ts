import { abortable, cancelBody } from "./cancellation"

/** The client call that owns this HTTP exchange, unchanged by request rewrites. */
export interface MiddlewareContext {
  readonly endpoint: string
  readonly kind: "fetch" | "result" | "stream"
}

/** Sends a request and resolves to its response, as `fetch` does. */
export type Fetcher = (request: Request) => Promise<Response>

/** Wrap an HTTP exchange; decoding and stream consumption happen after the chain returns. */
export type Middleware = (
  request: Request,
  next: Fetcher,
  context: MiddlewareContext,
) => Promise<Response>

/** A middleware, typed where it is written; returned as it is. */
export function defineMiddleware<T extends Middleware>(middleware: T): T {
  return middleware
}

/** Observe only transport failures, without wrapping errors seen by middleware or callers. */
export type Sender = (
  request: Request,
  context: MiddlewareContext,
  transportFailed?: (error: unknown) => void,
) => Promise<Response>

interface Exchange {
  context: MiddlewareContext
  signal: AbortSignal
  received: (response: Response) => Response
  transportFailed: ((error: unknown) => void) | undefined
}

type Dispatch = (request: Request, exchange: Exchange) => Promise<Response>

/** Compile the chain once; each dispatch owns its context and all responses until delivery. */
export function createSender(middleware: readonly Middleware[], transport?: Fetcher): Sender {
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
    return exchange.received(response)
  }
  const dispatch = middleware.reduceRight<Dispatch>(
    (next, wrap) => async (request, exchange) => {
      exchange.signal.throwIfAborted()
      return exchange.received(
        await wrap(request, (outgoing) => next(outgoing, exchange), exchange.context),
      )
    },
    transmit,
  )
  return async (request, context, transportFailed) => {
    const responses = new Set<Response>()
    let finished = false
    let delivered: Response | undefined
    const discard = (response: Response): void => {
      if (response !== delivered && response.body !== delivered?.body) cancelBody(response)
    }
    const exchange: Exchange = {
      context: Object.freeze({ ...context }),
      signal: request.signal,
      transportFailed,
      received(response) {
        if (finished) discard(response)
        else responses.add(response)
        return response
      },
    }
    try {
      request.signal.throwIfAborted()
      const response = await abortable(dispatch(request, exchange), request.signal)
      request.signal.throwIfAborted()
      delivered = response
      return response
    } finally {
      finished = true
      for (const response of responses) discard(response)
      responses.clear()
    }
  }
}
