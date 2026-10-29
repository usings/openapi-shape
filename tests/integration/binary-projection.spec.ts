import { expect, it } from "vitest"
import { createClient } from "../../src/client"
import { generate } from "../../src/core/index"
import type { ResultOperation } from "../support/contract"
import { contractOf } from "../support/contract"
import { declaration, oas } from "../support/generate"
import { expectPassesTsc } from "../support/tsc"
const binary = { type: "string", format: "binary" }
const document = () =>
  oas("3.1", {
    paths: {
      "/f": {
        post: {
          parameters: [{ name: "q", in: "query", schema: binary }],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Doc" } },
              "application/x-www-form-urlencoded": {
                schema: { $ref: "#/components/schemas/Doc" },
              },
              "multipart/form-data": { schema: { $ref: "#/components/schemas/Doc" } },
            },
          },
          responses: { "204": { description: "Done" } },
        },
      },
    },
    components: {
      schemas: { Doc: { type: "object", required: ["file"], properties: { file: binary } } },
    },
  })

it("types and encodes JSON/text strings separately from actual multipart files", async () => {
  const { code, diagnostics } = await generate(document())
  expect(diagnostics).toStrictEqual([])
  expect(declaration(code, "Doc")).toContain("file: string")
  expect(declaration(code, "DocMultipart")).toContain("file: Blob")
  await expectPassesTsc(
    code,
    `
import type { Endpoints } from "./file0"
import type { EndpointArgs } from "openapi-shape/client"
type Input = EndpointArgs<Endpoints, "POST /f">[0]
export const parts: Input = { headers: { "content-type": "multipart/form-data" }, body: { file: new Blob([]) } }
export const json: Input = { headers: { "content-type": "application/json" }, body: { file: "bytes" }, query: { q: "bytes" } }
export const form: Input = { headers: { "content-type": "application/x-www-form-urlencoded" }, body: { file: "bytes" } }
// @ts-expect-error JSON does not encode nested Blob values
export const invalidJson: Input = { body: { file: new Blob([]) } }
// @ts-expect-error parameters are text
export const invalidQuery: Input = { body: { file: "bytes" }, query: { q: new Blob([]) } }
`,
  )
  const sent: Request[] = []
  const api = createClient(
    await contractOf<
      Record<
        string,
        ResultOperation<{
          query?: unknown
          body?: Record<
            "application/json" | "multipart/form-data" | "application/x-www-form-urlencoded",
            unknown
          >
        }>
      >
    >(code),
    {
      baseURL: "https://api.test",
      fetch: (request) => {
        sent.push(request)
        return Promise.resolve(new Response(null, { status: 204 }))
      },
    },
  )
  await api.result("POST /f", {
    body: { file: "bytes" },
    query: { q: "bytes" },
    headers: { "content-type": "application/json" },
  })
  await api.result("POST /f", {
    body: { file: new Blob(["bytes"]) },
    headers: { "content-type": "multipart/form-data" },
  })
  expect(await sent[0].json()).toStrictEqual({ file: "bytes" })
  expect(sent[0].url).toBe("https://api.test/f?q=bytes")
  const form = await sent[1].formData()
  const file = form.get("file") as File
  expect(await file.text()).toBe("bytes")
})
