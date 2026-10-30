import type {
  Client,
  ResponseHeaders,
  TypedResponse,
  ResultEndpoint,
  EndpointArgs,
  EndpointResult,
  ResponseOf,
} from "openapi-shape/client"
import { expectTypeOf } from "vitest"

interface Endpoints {
  "HEAD /items": { responses: { 200: { headers: { ETag: string } } } }
  "GET /items": {
    responses: {
      200: { headers: { "X-Total": number } }
      "2XX": { headers: { "X-Range": string } }
      204: { headers: { ETag: string } }
      400: { headers: { "X-Error": string } }
    }
  }
}
declare const api: Client<Endpoints>
function forward<K extends ResultEndpoint<Endpoints>>(
  endpoint: K,
  ...args: EndpointArgs<Endpoints, K>
): Promise<EndpointResult<Endpoints, K>> {
  return api.result(endpoint, ...args)
}
void async function check() {
  const result = await forward("GET /items")
  if (result.status === 200)
    expectTypeOf(result.response.headers).toEqualTypeOf<ResponseHeaders<"x-total">>()
  if (result.status === 201) {
    expectTypeOf(result.response.status).toEqualTypeOf<201>()
    expectTypeOf(result.response.headers).toEqualTypeOf<ResponseHeaders<"x-range">>()
  }
  if (result.status === 204)
    expectTypeOf(result.response.headers).toEqualTypeOf<ResponseHeaders<"etag">>()
  if (result.status === 400)
    expectTypeOf(result.response.headers).toEqualTypeOf<ResponseHeaders<"x-error">>()
  const head = await api.result("HEAD /items")
  if (head.status === 200)
    expectTypeOf(head.response.headers).toEqualTypeOf<ResponseHeaders<"etag">>()
}
declare const legacy: TypedResponse<200, true, string>
expectTypeOf(legacy.headers.get("anything")).toEqualTypeOf<string | null>()

function forwardResponse<K extends keyof Endpoints>(
  endpoint: K,
  ...args: EndpointArgs<Endpoints, K>
): Promise<ResponseOf<Endpoints, K>> {
  return api.fetch(endpoint, ...args)
}
void async function checkResponseWrapper() {
  const response = await forwardResponse("GET /items")
  if (response.status === 200)
    expectTypeOf(response.headers).toEqualTypeOf<ResponseHeaders<"x-total">>()
}
