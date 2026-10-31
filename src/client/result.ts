import type { EndpointContract } from "../shared/contract"
import { isJsonEssence, mediaTypeEssence, streamFormat } from "../shared/media"
import { raceWithAbort, cancelBody } from "./cancellation"
import { ClientError } from "./errors"
import { matchDeclaredMedia, responseContentType } from "./media"
import { resolveResponseDeclaration } from "./response"

/**
 * A response body, by its content type: JSON parsed, `text/*` as a string, no content as
 * `undefined`, anything else as a `Blob`.
 */
async function decodeResponseBody(
  response: Response,
  signal: AbortSignal,
  media?: string,
  empty = false,
): Promise<unknown> {
  if (empty) {
    await raceWithAbort(response.body?.cancel(signal.reason) ?? Promise.resolve(), signal)
    return undefined
  }
  // Own cancellation even when middleware supplied a body unrelated to native Fetch's signal.
  // The pipeline cancels its source; raceWithAbort keeps a slow cleanup from delaying rejection.
  const cleanup = new AbortController()
  const readable =
    response.body && !response.bodyUsed
      ? new Response(
          response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
            signal: AbortSignal.any([signal, cleanup.signal]),
          }),
          { headers: response.headers },
        )
      : response
  try {
    return await raceWithAbort(readBody(readable, media), signal)
  } catch (error) {
    cleanup.abort(error)
    throw error
  }
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

export async function consumeResultResponse(
  response: Response,
  request: Request,
  endpointDeclaration: EndpointContract | undefined,
): Promise<unknown> {
  const responseDeclaration =
    endpointDeclaration && resolveResponseDeclaration(endpointDeclaration, response.status)
  if (response.status === 0 || !responseDeclaration) {
    cancelBody(response, request.signal.reason)
    throw new ClientError("Response status is not declared by this operation", {
      code: "UNDECLARED_STATUS",
      details: { response },
    })
  }
  const actualMedia = responseContentType(response.headers)
  const allowsBody = request.method !== "HEAD" && ![204, 205, 304].includes(response.status)
  if (allowsBody) {
    const content = responseDeclaration.content
    if (!content && response.body !== null) {
      cancelBody(response, request.signal.reason)
      throw new ClientError("Response body is not declared by this operation", {
        code: "INVALID_RESPONSE_BODY",
        details: { response },
      })
    }
    if (
      (actualMedia && streamFormat(actualMedia)) ||
      (content &&
        (actualMedia ? !matchDeclaredMedia(content, actualMedia) : !Object.hasOwn(content, "*/*")))
    ) {
      cancelBody(response, request.signal.reason)
      throw new ClientError("Response media does not match a complete declared representation", {
        code: "UNEXPECTED_MEDIA_TYPE",
        details: {
          response,
          expected: Object.keys(content ?? {}).filter((media) => !streamFormat(media)),
          actual: actualMedia,
        },
      })
    }
  }

  const body = await decodeResponseBody(
    response,
    request.signal,
    actualMedia,
    !allowsBody || !responseDeclaration.content,
  )
  // A failure's error is never undefined, which is what tells a success.
  const { status } = response
  return response.ok
    ? { data: body, error: undefined, status, response }
    : { data: undefined, error: body ?? null, status, response }
}
