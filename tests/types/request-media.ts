import { expectTypeOf } from "vitest"
import { createClient } from "../../src/client"
import type { DefaultMedia, SingleMedia } from "../../src/client/types/headers"
import type { Field, BodyVariant } from "../../src/client/types/request"
import type { LowercaseKeys } from "../../src/client/types/utils"
import type { Contract } from "../../src/shared/contract"

expectTypeOf<DefaultMedia<{ "CoNtEnT-TyPe": "text/plain" }>>().toEqualTypeOf<"text/plain">()
expectTypeOf<LowercaseKeys<{ readonly ACCEPT?: "text/plain"; 1: boolean }>>().toEqualTypeOf<{
  readonly accept?: "text/plain"
  1: boolean
}>()
expectTypeOf<
  Field<"query", { readonly query?: { q: string }; responses: Record<never, never> }>
>().toEqualTypeOf<{
  readonly query?: { q: string }
}>()

// Intersect media alternatives without destroying each schema's own union.
const shared: BodyVariant<{
  "application/json": { kind: "shared" } | { kind: "json" }
  "application/problem+json": { kind: "shared" } | { kind: "problem" }
}> = {
  headers: {
    "content-type": "application/json" as "application/json" | "application/problem+json",
  },
  body: { kind: "shared" },
}
void shared

interface Endpoints {
  "POST /form": {
    body: { "application/x-www-form-urlencoded": { name: string } }
    responses: { 200: { content: { "application/json": { ok: true } } } }
  }
}
void function checks(contract: Contract<Endpoints>, dynamic: `application/${string}`) {
  const client = createClient(contract, { headers: { "Content-Type": dynamic } })
  // @ts-expect-error an infinite media pattern cannot establish a default structured body association
  void client.fetch("POST /form", { body: { name: "test" } })
  void client.fetch("POST /form", {
    headers: { "CONTENT-TYPE": "application/x-www-form-urlencoded" },
    body: { name: "test" },
  })
  void client.fetch("POST /form", { body: new URLSearchParams() })
}

void function defaultChecks(
  contract: Contract<Endpoints>,
  options: { headers?: { "content-type": "application/x-www-form-urlencoded" } },
) {
  const client = createClient(contract, options)
  // @ts-expect-error optional default headers cannot establish form encoding
  void client.fetch("POST /form", { body: { name: "test" } })
  void client.fetch("POST /form", {
    headers: { "Content-Type": "APPLICATION/X-WWW-FORM-URLENCODED; charset=utf-8" },
    body: { name: "test" },
  })
  // @ts-expect-error request streams must contain bytes
  void client.fetch("POST /form", { body: new ReadableStream<string>() })
  void client.fetch("POST /form", { body: new ReadableStream<Uint8Array>() })
}

expectTypeOf<SingleMedia<`application/${string}`>>().toEqualTypeOf<never>()
expectTypeOf<SingleMedia<Uppercase<string>>>().toEqualTypeOf<never>()
expectTypeOf<SingleMedia<"application/json" | "text/plain">>().toEqualTypeOf<never>()
expectTypeOf<SingleMedia<"application/json">>().toEqualTypeOf<"application/json">()

void function wildcardChecks(
  contract: Contract<{
    "POST /wild": { body: { "application/*": { id: number } }; responses: { 204: object } }
  }>,
) {
  const api = createClient(contract)
  api.fetch("POST /wild", { headers: { "content-type": "application/json" }, body: { id: 1 } })
  // @ts-expect-error PDF needs an encoded body
  api.fetch("POST /wild", { headers: { "content-type": "application/pdf" }, body: { id: 1 } })
  const pdf = createClient(contract, { headers: { "content-type": "application/pdf" } })
  // @ts-expect-error a PDF default cannot encode a structured value
  pdf.fetch("POST /wild", { body: { id: 1 } })
  pdf.fetch("POST /wild", { body: new Blob() })
}
