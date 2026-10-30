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
