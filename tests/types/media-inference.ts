import { expectTypeOf } from "vitest"
import { createClient } from "../../src/client"
import type { DefaultMedia, SingleMedia } from "../../src/client/types/headers"
import type { Field, BodyVariant } from "../../src/client/types/request"
import type { IsStringLiteral, IsUnion, LowercaseKeys } from "../../src/client/types/utils"
import type { Contract } from "../../src/shared/contract"

expectTypeOf<IsUnion<never>>().toEqualTypeOf<false>()
expectTypeOf<IsUnion<{ a: 1 } | { a: number }>>().toEqualTypeOf<true>()
expectTypeOf<IsUnion<any>>().toEqualTypeOf<false>()
expectTypeOf<IsStringLiteral<any>>().toEqualTypeOf<false>()
expectTypeOf<IsStringLiteral<never>>().toEqualTypeOf<false>()
expectTypeOf<IsStringLiteral<"a" | "b">>().toEqualTypeOf<true>()
expectTypeOf<SingleMedia<`application/${string}`>>().toEqualTypeOf<never>()
expectTypeOf<SingleMedia<Uppercase<string>>>().toEqualTypeOf<never>()
expectTypeOf<SingleMedia<"application/json" | "text/plain">>().toEqualTypeOf<never>()
expectTypeOf<SingleMedia<"application/json">>().toEqualTypeOf<"application/json">()
interface Brand {
  readonly __brand: unique symbol
}
expectTypeOf<IsStringLiteral<string & Brand>>().toEqualTypeOf<false>()
expectTypeOf<IsStringLiteral<"application/json" & Brand>>().toEqualTypeOf<true>()
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

interface StreamingEndpoints {
  "GET /events": {
    responses: {
      200: {
        content: {
          "text/event-stream": Array<{ data: string }>
          "application/x-ndjson": Array<{ id: number }>
        }
      }
    }
  }
}
void function defaultStreamChecks(contract: Contract<StreamingEndpoints>) {
  const client = createClient(contract, { headers: { Accept: "text/event-stream" } })
  const stream = client.stream("GET /events", { retry: { maxRetries: 2 } })
  expectTypeOf(stream).toExtend<ReadableStream<{ data: string }>>()
  const records = client.stream("GET /events", { headers: { ACCEPT: "application/x-ndjson" } })
  expectTypeOf(records).toEqualTypeOf<ReadableStream<{ id: number }>>()
  // @ts-expect-error overriding Accept must preserve non-SSE retry restrictions
  client.stream("GET /events", {
    headers: { ACCEPT: "application/x-ndjson" },
    retry: { maxRetries: 2 },
  })
}

interface MixedEndpoints {
  "POST /mixed": {
    body: { "application/json": { j: string }; "application/x-www-form-urlencoded": { f: string } }
    responses: {
      200: {
        content: {
          "text/event-stream": Array<{ data: string }>
          "application/x-ndjson": Array<{ id: number }>
        }
      }
    }
  }
}
void function regressionChecks(
  contract: Contract<MixedEndpoints>,
  defaults: { authorization: string } | { "content-type": "application/x-www-form-urlencoded" },
) {
  const client = createClient(contract, { headers: { Accept: "text/event-stream" } })
  // @ts-expect-error a default Accept does not supply the form Content-Type
  client.stream("POST /mixed", { body: { f: "form" } })
  // @ts-expect-error case-insensitive headers must retain their body association
  client.stream("POST /mixed", {
    body: { j: "wrong" },
    headers: { "CONTENT-TYPE": "application/x-www-form-urlencoded", "accept": "text/event-stream" },
  })
  // @ts-expect-error opaque Accept overrides cannot enable automatic SSE retry
  client.stream("POST /mixed", {
    body: new Blob(),
    headers: new Headers({ Accept: "application/x-ndjson" }),
    retry: { maxRetries: 1 },
  })
  const dynamic = createClient(contract, { headers: defaults })
  // @ts-expect-error defaults may select form instead of JSON
  dynamic.fetch("POST /mixed", { body: { j: "json" } })
  createClient(contract, {
    headers: { Accept: "text/event-stream" },
    // @ts-expect-error configuration-level signals are forbidden even with inferred options
    signal: AbortSignal.timeout(100),
  })
  client.stream("POST /mixed", {
    body: { j: "json" },
    headers: { "Content-Type": "APPLICATION/JSON; charset=utf-8", "accept": "text/event-stream" },
  })
  client.fetch("POST /mixed", {
    body: { j: "json" },
    headers: { "Content-Type": "APPLICATION/JSON; charset=utf-8" },
  })
}

void function opaqueDefaultChecks(
  contract: Contract<{
    "GET /sse": {
      responses: { 200: { content: { "text/event-stream": Array<{ data: string }> } } }
    }
  }>,
  accept: string,
) {
  const client = createClient(contract, { headers: { accept } })
  // @ts-expect-error an opaque default may negotiate something other than SSE
  client.stream("GET /sse", { retry: { maxRetries: 1 } })
  client.stream("GET /sse", { headers: { ACCEPT: "text/event-stream" }, retry: { maxRetries: 1 } })
}
