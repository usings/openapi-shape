import { describe, expect, it } from "vitest"
import { createClient } from "../src/client"
import { generate } from "../src/core/index"
import type { ResultOperation } from "./helpers/contract"
import { contractOf } from "./helpers/contract"
import { codes, declaration, entry, oas } from "./helpers/generate"
import { expectPassesTsc, typecheck } from "./helpers/tsc"

/** Check decoding through the client while generated types retain media schemas. */
async function contentType(
  mediaType: string,
  media: object,
  expected: string,
  version: "3.0" | "3.1" | "3.2" = "3.1",
  output: "EndpointData" | "EndpointStreamItem" = "EndpointData",
): Promise<string> {
  const { code } = await generate(
    oas(version, {
      paths: { "/r": { get: { responses: { "200": { content: { [mediaType]: media } } } } } },
    }),
  )
  return typecheck({
    "file0.ts": code,
    "use.ts": `
import type { ${output} } from "openapi-shape/client"
import type { Endpoints } from "./file0"
type Actual = ${output}<Endpoints, "GET /r">
type Expected = ${expected}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const equal: Equal<Actual, Expected> = true
`,
  })
}

describe("response decoding", () => {
  it.each([false, true])(
    "preserves binary string literals through allOf (reversed: %s)",
    async (reverse) => {
      const members = [{ type: "string", format: "binary" }, { const: "abc" }]
      const schema = { allOf: reverse ? members.toReversed() : members }
      const { code } = await generate(
        oas("3.2", {
          paths: {
            "/literal": {
              post: {
                requestBody: { required: true, content: { "application/json": { schema } } },
                responses: { "200": { content: { "application/json": { schema } } } },
              },
            },
          },
        }),
      )
      await expectPassesTsc(
        code,
        `
import { createClient } from "openapi-shape/client"
import { contract } from "./file0"
const api = createClient(contract)
const result = await api.result("POST /literal", { body: "abc" })
if (result.error === undefined) {
  result.data satisfies "abc"
  const value: typeof result.data = "abc"
}
// @ts-expect-error the literal constraint still applies
void api.result("POST /literal", { body: "other" })
`,
      )
    },
  )

  it.each([
    ["application/json", {}, "unknown"],
    ["application/problem+json", { schema: {} }, "unknown"],
    ["*/*", {}, "unknown"],
    ["text/plain", {}, "string"],
    ["text/*", {}, "unknown"],
    ["image/png", {}, "Blob"],
    ["application/octet-stream", { schema: { description: "annotation only" } }, "Blob"],
    ["application/xml", {}, "Blob"],
  ])("%s without schema decodes to %s", async (media, schema, expected) => {
    expect(await contentType(media, schema, expected)).toBe("")
  })

  const object = { type: "object", properties: { id: { type: "integer" } } }
  it.each([
    ["text/json", object, "{ id?: number }"],
    ["*/*", { type: "integer" }, "number | string | Blob"],
    ["application/x-www-form-urlencoded", object, "Blob"],
    ["multipart/form-data", object, "Blob"],
    ["text/csv", { type: "string" }, "string"],
    ["text/plain", { type: "integer" }, "string"],
    ["text/plain", { oneOf: [{ type: "integer" }, { type: "boolean" }] }, "string"],
    ["text/plain", { enum: ["ok", "no"] }, '"ok" | "no"'],
    ["text/*", { enum: ["ok", "no"] }, '"ok" | "no"'],
    ["text/*", object, "unknown"],
    ["application/xml", object, "Blob"],
    ["application/vnd.github.diff", { type: "string" }, "Blob"],
    ["image/png", { type: "string", format: "binary" }, "Blob"],
  ])("%s decodes according to the response media", async (media, schema, expected) => {
    expect(await contentType(media, { schema }, expected)).toBe("")
  })

  it.each(["3.0", "3.1"] as const)(
    "projects binary annotations in %s by transport",
    async (version) => {
      const bytes = { schema: { type: "string", format: "binary" } }
      expect(await contentType("application/json", bytes, "string", version)).toBe("")
      expect(await contentType("text/plain", bytes, "string", version)).toBe("")
      expect(await contentType("text/*", bytes, "unknown", version)).toBe("")
      expect(await contentType("*/*", bytes, "string | Blob", version)).toBe("")
      expect(await contentType("image/png", bytes, "Blob", version)).toBe("")
      expect(
        await contentType(
          "application/json",
          { schema: { type: "string", contentMediaType: "image/png" } },
          "string",
          version,
        ),
      ).toBe("")
    },
  )
})

describe("sequential content", () => {
  it.each([
    { const: { event: "added", data: "hello", extra: true } },
    {
      enum: [
        { event: "added", data: "hello" },
        { event: "removed", data: "bye" },
      ],
    },
  ])("preserves SSE object literal fields and their correlations: %j", async (itemSchema) => {
    const { code } = await generate(
      oas("3.2", {
        paths: {
          "/events": {
            get: {
              responses: {
                "200": { content: { "text/event-stream": { itemSchema } } },
              },
            },
          },
        },
      }),
    )
    await expectPassesTsc(
      code,
      `
import { createClient } from "openapi-shape/client"
import { contract } from "./file0"
const api = createClient(contract)
for await (const message of api.stream("GET /events")) {
  message.event satisfies "added" | "removed"
  if (message.event === "added") message.data satisfies "hello"
  message.id satisfies string
  message.retry satisfies number | undefined
  // @ts-expect-error custom fields are not parsed from SSE
  message.extra
}
`,
    )
  })

  it("derives SSE messages from the declared response media", async () => {
    const { code, diagnostics } = await generate(
      oas("3.2", {
        paths: {
          "/events": {
            get: {
              responses: {
                "200": {
                  content: {
                    "text/event-stream": {
                      itemSchema: {
                        type: "object",
                        properties: {
                          data: { type: "string" },
                          event: { const: "update" },
                          extra: { type: "number" },
                        },
                        required: ["data", "event"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    )
    expect(diagnostics).toStrictEqual([])
    await typecheck({
      "api.ts": code,
      "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
for await (const message of api.stream("GET /events")) {
  message.event satisfies "update"
  message.data satisfies string
  // @ts-expect-error custom schema fields are not parsed SSE fields
  message.extra
}
// @ts-expect-error streams are consumed separately
void api.result("GET /events")
`,
    }).then((errors) => expect(errors).toBe(""))
  })

  it("requires encoded JSON sequences and streams parsed items", async () => {
    const { code, diagnostics } = await generate(
      oas("3.1", {
        paths: {
          "/r": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "application/x-ndjson": { schema: { type: "array", items: { type: "integer" } } },
                },
              },
              responses: {
                "200": {
                  content: {
                    "application/jsonl": { itemSchema: { type: "integer" } },
                    "application/json": { itemSchema: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      }),
    )
    expect(entry(code, "POST /r")).toContain('body: { "application/x-ndjson": number[] }')
    expect(entry(code, "POST /r")).toContain('"application/jsonl": number[]')
    expect(
      await contentType(
        "application/jsonl",
        { itemSchema: { type: "integer" } },
        "number",
        "3.2",
        "EndpointStreamItem",
      ),
    ).toBe("")
    await expectPassesTsc(
      code,
      `
import { createClient } from "openapi-shape/client"
import { contract } from "./file0"
const api = createClient(contract)
for await (const item of api.stream("POST /r", { body: "1\\n2\\n" })) {
  item satisfies number
}
// @ts-expect-error sequences require encoded text or a ready body
void api.stream("POST /r", { body: [1, 2] })
`,
    )
    expect(codes(diagnostics)).toStrictEqual([
      "ignored-field #/paths/~1r/post/responses/200/content/application~1json/itemSchema",
    ])
  })

  it.each([
    [{ schema: { type: "array", items: { type: "integer" } } }, "number"],
    [{ itemSchema: { type: "array", items: { type: "integer" } } }, "number[]"],
    [
      {
        schema: { type: "array", items: { type: "string" } },
        itemSchema: { type: "integer" },
      },
      "number",
    ],
    [{ schema: { type: "integer" } }, "unknown"],
    [{}, "unknown"],
  ])("distinguishes whole sequence schemas from item schemas: %j", async (media, expected) => {
    expect(
      await contentType("application/x-ndjson", media, expected, "3.2", "EndpointStreamItem"),
    ).toBe("")
  })

  it("preserves referenced whole sequence schemas and gives itemSchema precedence", async () => {
    const { code } = await generate(
      oas("3.2", {
        paths: {
          "/whole": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/jsonl": { schema: { $ref: "#/components/schemas/Rows" } },
                  },
                },
              },
            },
          },
          "/items": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/x-ndjson": {
                      schema: { $ref: "#/components/schemas/Rows" },
                      itemSchema: { $ref: "#/components/schemas/Row" },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Row: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
            Rows: { type: "array", items: { $ref: "#/components/schemas/Row" } },
          },
        },
      }),
    )
    await expectPassesTsc(
      code,
      `
import type { EndpointStreamItem } from "openapi-shape/client"
import type { Endpoints } from "./file0"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const whole: Equal<EndpointStreamItem<Endpoints, "GET /whole">, { id: number }> = true
const items: Equal<EndpointStreamItem<Endpoints, "GET /items">, { id: number }> = true
`,
    )
  })

  it("records supported effective stream media in response order with their full declarations", async () => {
    const jsonl = "Application/JSONL; charset=utf-8"
    const sse = "TEXT/Event-Stream; profile=updates"
    const ndjson = "application/x-ndjson; charset=utf-8"
    const { code } = await generate(
      oas("3.2", {
        paths: {
          "/streams": {
            get: {
              responses: {
                "200": { content: { [jsonl]: { schema: false } } },
                "201": { content: { [sse]: {} } },
                "204": { content: { "text/event-stream": {} } },
                "205": { content: { "application/jsonl": {} } },
                "2XX": {
                  content: {
                    [ndjson]: {},
                    [jsonl]: {},
                    "application/json-seq": {},
                    "application/example+json-seq": {},
                  },
                },
                "default": { content: { "application/jsonl; profile=fallback": {} } },
              },
            },
          },
          "/fallback": {
            get: { responses: { default: { content: { [ndjson]: {} } } } },
          },
          "/head": {
            head: { responses: { "200": { content: { [ndjson]: {} } } } },
          },
          "/shadowed": {
            get: {
              responses: {
                "2XX": { content: { [ndjson]: {} } },
                ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(200 + i), {}])),
              },
            },
          },
        },
      }),
    )
    const { endpoints } = await contractOf(code)
    expect(endpoints["GET /streams"]).toStrictEqual({ stream: [jsonl, sse, ndjson] })
    expect(endpoints["GET /fallback"]).toStrictEqual({ stream: [ndjson] })
    expect(endpoints["HEAD /head"]).toStrictEqual({})
    expect(endpoints["GET /shadowed"]).toStrictEqual({})
  })
})

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
              "application/x-www-form-urlencoded": { schema: { $ref: "#/components/schemas/Doc" } },
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

describe("request projections", () => {
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
export const parts: Input = { contentType: "multipart/form-data", body: { file: new Blob([]) } }
export const json: Input = { contentType: "application/json", body: { file: "bytes" }, query: { q: "bytes" } }
export const form: Input = { contentType: "application/x-www-form-urlencoded", body: { file: "bytes" } }
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
            body?: unknown
            query?: unknown
            contentType?:
              | "application/json"
              | "multipart/form-data"
              | "application/x-www-form-urlencoded"
          }>
        >
      >(code),
      {
        baseUrl: "https://api.test",
        fetch: (request) => {
          sent.push(request)
          return Promise.resolve(new Response(null, { status: 204 }))
        },
      },
    )
    await api.result("POST /f", { body: { file: "bytes" }, query: { q: "bytes" } })
    await api.result("POST /f", {
      contentType: "multipart/form-data",
      body: { file: new Blob(["bytes"]) },
    })
    expect(await sent[0].json()).toStrictEqual({ file: "bytes" })
    expect(sent[0].url).toBe("https://api.test/f?q=bytes")
    const form = await sent[1].formData()
    const file = form.get("file") as File
    expect(await file.text()).toBe("bytes")
  })

  it("projects recursive JSON, styled fields and nested multipart values to encodable strings", async () => {
    const { code, diagnostics } = await generate(
      oas("3.1", {
        paths: {
          "/f": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "multipart/form-data": {
                    schema: {
                      type: "object",
                      required: ["file", "files", "nested", "matrix", "styled"],
                      properties: {
                        file: binary,
                        files: { type: "array", items: binary },
                        nested: { $ref: "#/components/schemas/Node" },
                        matrix: { type: "array", items: { type: "array", items: binary } },
                        styled: binary,
                      },
                    },
                    encoding: { styled: { style: "form" } },
                  },
                },
              },
              responses: { "204": { description: "Done" } },
            },
          },
        },
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: { file: binary, next: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      }),
    )
    expect(diagnostics).toStrictEqual([])
    await expectPassesTsc(
      code,
      `
import type { Endpoints } from "./file0"
import type { EndpointArgs } from "openapi-shape/client"
type Input = EndpointArgs<Endpoints, "POST /f">[0]
export const input: Input = { body: {
  file: new Blob([]), files: [new Blob([])], nested: { file: "bytes", next: { file: "more" } }, matrix: [["bytes"]], styled: "bytes"
} }
// @ts-expect-error a nested array part is JSON-encoded, not a file
export const bad: Input = { body: { file: new Blob([]), files: [], nested: {}, matrix: [[new Blob([])]], styled: "bytes" } }
`,
    )
  })
})

it("excludes non-object form inputs and keeps referenced text literals", async () => {
  const { code } = await generate(
    oas("3.2", {
      components: { schemas: { Word: { type: "string", enum: ["ok", "no"] } } },
      paths: {
        "/form": {
          post: {
            requestBody: {
              required: true,
              content: { "application/x-www-form-urlencoded": { schema: { type: "number" } } },
            },
            responses: { "204": {} },
          },
        },
        "/text": {
          get: {
            responses: {
              "200": {
                content: { "text/plain": { schema: { $ref: "#/components/schemas/Word" } } },
              },
            },
          },
        },
        "/custom": { additionalOperations: { CuStOm: { responses: { "204": {} } } } },
      },
    }),
  )
  expect(
    await typecheck({
      "api.ts": code,
      "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const api = createClient(contract)
// @ts-expect-error a form encoder cannot encode a number as fields
void api.fetch("POST /form", { body: 1 })
void api.fetch("POST /form", { body: "already=encoded" })
async function use() {
  const result = await api.result("GET /text")
  if (result.error === undefined) result.data satisfies "ok" | "no"
}
`,
    }),
  ).toBe("")
  const contract = await contractOf(code)
  expect(contract.endpoints["CuStOm /custom"]).toStrictEqual({})
  const api = createClient(contract, {
    baseUrl: "https://api.test",
    fetch: (request) => {
      expect(request.method).toBe("CuStOm")
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  await api.fetch("CuStOm /custom")
})
