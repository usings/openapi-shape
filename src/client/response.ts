import type { EndpointContract } from "../shared/contract"
import { isJsonEssence, mediaTypeEssence, streamFormat } from "../shared/media"
import { abortable, cancelBody } from "./cancellation"
import { matchDeclaredMedia, responseContentType } from "./media"

/**
 * A response body, by its content type: JSON parsed, `text/*` as a string, no content as
 * `undefined`, anything else as a `Blob`.
 */
export async function decodeBody(
  response: Response,
  method: string,
  signal: AbortSignal,
  media?: string,
  empty = false,
): Promise<unknown> {
  if (empty || method === "HEAD" || [204, 205, 304].includes(response.status)) {
    await abortable(response.body?.cancel(signal.reason) ?? Promise.resolve(), signal)
    return undefined
  }
  // Own cancellation even when middleware supplied a body unrelated to native Fetch's signal.
  // The pipeline cancels its source; abortable keeps a slow cleanup from delaying rejection.
  const readable =
    response.body && !response.bodyUsed
      ? new Response(
          response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }),
          { headers: response.headers },
        )
      : response
  return await abortable(readBody(readable, media), signal)
}

/** Decode through native Response methods without changing the original response's metadata. */
async function readBody(response: Response, media?: string): Promise<unknown> {
  const essence = media ? mediaTypeEssence(media) : undefined
  if (essence === undefined) {
    const blob = await response.blob()
    return blob
  }
  if (isJsonEssence(essence)) return response.json()
  if (essence.startsWith("text/")) return response.text()
  return response.blob()
}

export async function readResult(
  response: Response,
  request: Request,
  declared: EndpointContract | undefined,
): Promise<unknown> {
  const resolved = declared && resolveResponseDeclaration(declared, response.status)
  if (!resolved) {
    cancelBody(response, request.signal.reason)
    throw new ContractResponseError("Response status is not declared by this operation", response)
  }
  const actualMedia = responseContentType(response.headers)
  if (request.method !== "HEAD" && ![204, 205, 304].includes(response.status)) {
    const shape = resolved
    const actual = actualMedia
    const media = actual ? mediaTypeEssence(actual) : undefined
    if (
      (media && streamFormat(media)) ||
      (shape && !shape.content && response.body !== null) ||
      (shape?.content &&
        (actual
          ? !matchDeclaredMedia(shape.content, actual)
          : !Object.hasOwn(shape.content, "*/*")))
    ) {
      cancelBody(response, request.signal.reason)
      throw new ContractResponseError(
        "Response media does not match a complete declared representation",
        response,
      )
    }
  }
  const body = await decodeBody(
    response,
    request.method,
    request.signal,
    actualMedia,
    !resolved.content,
  )
  // A failure's error is never undefined, which is what tells a success.
  const { status } = response
  return response.ok
    ? { data: body, error: undefined, status, response }
    : { data: undefined, error: body ?? null, status, response }
}

export function resolveResponseDeclaration(endpoint: EndpointContract, status: number) {
  const responses = endpoint.responses
  return (
    responses[String(status)] ?? responses[`${Math.floor(status / 100)}XX`] ?? responses.default
  )
}

/** A response that cannot be decoded according to the generated contract. */
export class ContractResponseError extends Error {
  constructor(
    message: string,
    readonly response: Response,
  ) {
    super(message)
    this.name = "ContractResponseError"
  }
}
