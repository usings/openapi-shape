import type { Client } from "openapi-shape/client"
interface Json<T> {
  content: { "application/json": T }
}
interface Endpoints {
  "POST /items": {
    params: { id: string }
    body: { "application/json": { name: string }; "text/plain": "ready" }
    responses: {
      200: Json<{ exact: true }>
      "2XX": Json<{ ranged: true }>
      404: Json<{ missing: true }>
      "4XX": Json<{ failed: true }>
      "default": Json<{ fallback: true }>
    }
  }
  "GET /impossible": { responses: { 200: Json<never> } }
}
declare const api: Client<Endpoints>
void api.result("POST /items", {
  params: { id: "a" },
  body: { name: "a" },
  headers: { "content-type": "application/json" },
})
void api.result("POST /items", {
  params: { id: "a" },
  body: "ready",
  headers: { "content-type": "text/plain" },
})
// @ts-expect-error flat params remain required
void api.result("POST /items", {
  body: { name: "a" },
  headers: { "content-type": "application/json" },
})
// @ts-expect-error required body remains required
void api.result("POST /items", { params: { id: "a" } })
// @ts-expect-error request media selects its own body shape
void api.result("POST /items", {
  params: { id: "a" },
  body: { name: "a" },
  headers: { "content-type": "text/plain" },
})
export async function check() {
  const result = await api.result("POST /items", {
    params: { id: "a" },
    body: { name: "a" },
    headers: { "content-type": "application/json" },
  })
  if (result.status === 200) result.data satisfies { exact: true }
  if (result.status === 201) result.data satisfies { ranged: true }
  if (result.status === 204 || result.status === 205) result.data satisfies undefined
  if (result.status === 404) result.error satisfies { missing: true }
  if (result.status === 405) result.error satisfies { failed: true }
  if (result.status === 500) result.error satisfies { fallback: true }
  if (result.status === 304) result.error satisfies null
  const response = await api.fetch("POST /items", {
    params: { id: "a" },
    body: { name: "a" },
    headers: { "content-type": "application/json" },
  })
  if (response.status === 200) response.json() satisfies Promise<{ exact: true }>
  if (response.status === 201) response.json() satisfies Promise<{ ranged: true }>
  if (response.status === 404) response.json() satisfies Promise<{ missing: true }>
  const impossible = await api.fetch("GET /impossible")
  if (impossible.status === 200) impossible.json() satisfies Promise<never>
}
