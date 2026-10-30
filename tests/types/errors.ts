import { ClientError } from "openapi-shape/client"
import type { ClientDiagnostic } from "openapi-shape/client"
import { expectTypeOf } from "vitest"

void function narrow(error: unknown) {
  if (!(error instanceof ClientError)) return
  expectTypeOf(error).toEqualTypeOf<ClientError>()
  switch (error.code) {
    case "HTTP_ERROR":
    case "UNDECLARED_STATUS":
    case "INVALID_RESPONSE_BODY":
      expectTypeOf(error.details).toEqualTypeOf<{ readonly response: Response }>()
      break
    case "UNEXPECTED_MEDIA_TYPE":
      expectTypeOf(error.details.expected).toEqualTypeOf<readonly string[]>()
      expectTypeOf(error.details.actual).toEqualTypeOf<string | undefined>()
      expectTypeOf(error.details.response).toEqualTypeOf<Response>()
      // @ts-expect-error media failures do not carry a record position
      void error.details.line
      break
    case "INVALID_STREAM_RECORD":
      expectTypeOf(error.details).toEqualTypeOf<{ readonly line: number }>()
      // @ts-expect-error parser errors have no response metadata
      void error.details.response
      break
    case "MESSAGE_TOO_LARGE":
      expectTypeOf(error.details).toEqualTypeOf<{
        readonly maxMessageBytes: number
        readonly receivedBytes: number
      }>()
      break
    default:
      expectTypeOf(error).toEqualTypeOf<never>()
  }
}

void function forward<D extends ClientDiagnostic>(diagnostic: D) {
  return new ClientError("Forwarded failure", diagnostic)
}
void new ClientError("Too large", {
  code: "MESSAGE_TOO_LARGE",
  details: { maxMessageBytes: 8, receivedBytes: 9 },
})
// @ts-expect-error code and diagnostic details must belong to the same union member
void new ClientError("Wrong details", { code: "MESSAGE_TOO_LARGE", details: { line: 1 } })
// @ts-expect-error diagnostic fields are required, not a bag of optional properties
void new ClientError("Missing media", {
  code: "UNEXPECTED_MEDIA_TYPE",
  details: { response: new Response() },
})
