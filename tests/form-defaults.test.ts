import { expect, it } from "vitest"
import { createClient } from "../src/client"
import { generate } from "../src/core/index"
import { contractOf } from "./helpers/contract"
import { oas } from "./helpers/generate"
import { typecheck } from "./helpers/tsc"

const form = "application/x-www-form-urlencoded"
const multipart = "multipart/form-data"
const meta = { type: "object", required: ["id"], properties: { id: { type: "integer" } } }
const schema = {
  type: "object",
  properties: {
    meta,
    list: { type: "array", items: meta },
    nested: { type: "array", items: { type: "array", items: { type: "integer" } } },
    tags: { type: "array", items: { type: "string" } },
  },
}
const body = { meta: { id: 1 }, list: [{ id: 2 }, { id: 3 }], nested: [[4, 5]], tags: ["a", "b"] }

function operation(content: object) {
  return { requestBody: { required: true, content }, responses: { "204": { description: "OK" } } }
}

it.each(["3.0", "3.1", "3.2"] as const)(
  "derives %s form defaults through inline, composed and external schemas",
  async (version) => {
    await Promise.all(
      [false, true].map(async (referenced) => {
        const input = referenced ? { allOf: [{ $ref: "https://schemas.test/form.json" }] } : schema
        const { code, diagnostics } = await generate(
          oas(version, {
            paths: {
              "/form": {
                post: operation({ [form]: { schema: input }, [multipart]: { schema: input } }),
              },
            },
          }),
          {
            base: "https://api.test/openapi.json",
            load: (uri) => {
              if (String(uri) !== "https://schemas.test/form.json")
                throw new Error(`Unexpected URI ${uri}`)
              return Response.json(schema)
            },
          },
        )
        expect(diagnostics).toStrictEqual([])
        const contract = await contractOf<{
          "POST /form": {
            body: Record<typeof form | typeof multipart, typeof body>
            responses: object
          }
        }>(code)
        const requests: Request[] = []
        const client = createClient(contract, {
          baseUrl: "https://api.test",
          fetch: (request) => {
            requests.push(request)
            return Promise.resolve(new Response(null, { status: 204 }))
          },
        })
        await client.fetch("POST /form", { contentType: form, body })
        await client.fetch("POST /form", { contentType: multipart, body })
        expect([...new URLSearchParams(await requests[0].text())]).toStrictEqual([
          ["meta", '{"id":1}'],
          ["list", '{"id":2}'],
          ["list", '{"id":3}'],
          ["nested", "[4,5]"],
          ["tags", "a"],
          ["tags", "b"],
        ])
        const raw = await requests[1].clone().text()
        expect(raw).toContain('name="meta"; filename="blob"\r\nContent-Type: application/json')
        const parts = await requests[1].formData()
        expect(parts.get("meta")).toMatchObject({ type: "application/json" })
        expect(await (parts.get("meta") as Blob).text()).toBe('{"id":1}')
        expect(
          await Promise.all(parts.getAll("list").map((part) => (part as Blob).text())),
        ).toStrictEqual(['{"id":2}', '{"id":3}'])
        expect(await (parts.get("nested") as Blob).text()).toBe("[4,5]")
        expect(parts.getAll("tags")).toStrictEqual(["a", "b"])
      }),
    )
  },
)

it("keeps explicit styles, serializes content arrays item by item, and treats querystring as form content", async () => {
  const encoding = { meta: { style: "form" }, tags: { contentType: "application/json" } }
  const { code, diagnostics } = await generate(
    oas("3.2", {
      paths: {
        "/form": {
          post: operation({ [form]: { schema, encoding }, [multipart]: { schema, encoding } }),
        },
        "/query": {
          get: {
            parameters: [
              { in: "querystring", name: "query", required: true, content: { [form]: { schema } } },
            ],
            responses: { "204": { description: "OK" } },
          },
        },
      },
    }),
  )
  expect(diagnostics).toStrictEqual([])
  expect(
    await typecheck(
      {
        "api.ts": code,
        "consumer.ts": `
    import { createClient } from "openapi-shape/client"
    import { contract } from "./api"
    const api = createClient(contract)
    api.fetch("POST /form", { contentType: "${form}", body: ${JSON.stringify(body)} })
    api.fetch("GET /query", { query: ${JSON.stringify(body)} })
    // @ts-expect-error generated schema still rejects an invalid field value
    api.fetch("POST /form", { contentType: "${form}", body: { meta: { id: "bad" } } })
  `,
      },
      { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
    ),
  ).toBe("")
  const contract = await contractOf<{
    "POST /form": { body: Record<typeof form | typeof multipart, typeof body>; responses: object }
    "GET /query": { query: typeof body; responses: object }
  }>(code)
  const requests: Request[] = []
  const api = createClient(contract, {
    baseUrl: "https://api.test",
    fetch: (request) => {
      requests.push(request)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  await api.fetch("POST /form", { contentType: form, body })
  await api.fetch("POST /form", { contentType: multipart, body })
  await api.fetch("GET /query", { query: body })
  const fields = new URLSearchParams(await requests[0].text())
  expect(fields.get("id")).toBe("1")
  expect(fields.has("meta")).toBe(false)
  expect(fields.getAll("tags")).toStrictEqual(['"a"', '"b"'])
  const parts = await requests[1].formData()
  expect(parts.get("id")).toBe("1")
  expect(parts.has("meta")).toBe(false)
  expect(new URL(requests[2].url).searchParams.get("meta")).toBe('{"id":1}')
})

it("retains schema annotations for defaults and handles prototype-like names as ordinary fields", async () => {
  const properties = JSON.parse(
    '{"__proto__":{"type":"object","properties":{"id":{"type":"integer"}}}}',
  ) as Record<string, unknown>
  Object.assign(properties, {
    inferred: { const: "x" },
    encoded: {
      type: "array",
      items: { allOf: [{ $ref: "#/components/schemas/Encoded" }, { type: "string" }] },
    },
    nullable: { type: ["object", "null"], properties: { id: { type: "integer" } } },
    file: { type: "string", format: "binary" },
  })
  const { code, diagnostics } = await generate(
    oas("3.1", {
      components: { schemas: { Encoded: { type: "string", contentEncoding: "base64" } } },
      paths: {
        "/form": { post: operation({ [multipart]: { schema: { type: "object", properties } } }) },
      },
    }),
  )
  expect(diagnostics).toStrictEqual([])
  const generated = await contractOf<{
    "POST /form": { body: Record<typeof multipart, Record<string, unknown>>; responses: object }
  }>(code)
  const requests: Request[] = []
  const api = createClient(generated, {
    baseUrl: "https://api.test",
    fetch: (request) => {
      requests.push(request)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  const input = JSON.parse(
    '{"__proto__":{"id":1},"inferred":"x","encoded":["eA=="],"nullable":null}',
  ) as Record<string, unknown>
  input.file = new File(["raw"], "file.txt", { type: "text/plain" })
  await api.fetch("POST /form", { body: input })
  const parts = await requests[0].formData()
  expect(parts.get("__proto__")).toMatchObject({ type: "application/json" })
  expect(await (parts.get("__proto__") as Blob).text()).toBe('{"id":1}')
  expect(parts.get("inferred")).toMatchObject({ type: "application/octet-stream" })
  expect(parts.get("encoded")).toMatchObject({ type: "application/octet-stream" })
  expect(await (parts.get("encoded") as Blob).text()).toBe("eA==")
  expect(parts.get("nullable")).toMatchObject({ type: "application/json" })
  expect(await (parts.get("nullable") as Blob).text()).toBe("null")
  expect(parts.get("file")).toMatchObject({ type: "application/octet-stream", name: "file.txt" })
})

it("diagnoses ambiguous, recursive and over-budget defaults, while explicit encodings resolve them", async () => {
  const properties = {
    mixed: { anyOf: [{ type: "string" }, { type: "object" }] },
    annotated: { anyOf: [{ type: "string" }, { type: "string", contentEncoding: "base64" }] },
    recursive: { type: "array", items: { $ref: "#/components/schemas/Recursive" } },
    complex: {
      allOf: Array.from({ length: 7 }, () => ({ anyOf: [{ type: "string" }, { type: "object" }] })),
    },
  }
  const make = (encoding?: object) =>
    oas("3.1", {
      components: { schemas: { Recursive: { $ref: "#/components/schemas/Recursive" } } },
      paths: {
        "/form": {
          post: operation({
            [form]: { schema: { type: "object", properties }, ...(encoding ? { encoding } : {}) },
          }),
        },
      },
    })
  const { diagnostics } = await generate(make())
  const warnings = diagnostics.filter((diagnostic) => diagnostic.code === "ignored-field")
  expect(warnings).toHaveLength(4)
  for (const name of Object.keys(properties)) {
    expect(warnings.some((warning) => warning.message.includes(`"${name}"`))).toBe(true)
  }
  expect(
    warnings.every((warning) =>
      warning.location.endsWith("application~1x-www-form-urlencoded/schema"),
    ),
  ).toBe(true)
  const { diagnostics: resolved } = await generate(
    make(
      Object.fromEntries(
        Object.keys(properties).map((name) => [name, { contentType: "application/json" }]),
      ),
    ),
  )
  expect(resolved.filter((diagnostic) => diagnostic.code === "ignored-field")).toStrictEqual([])
})

it("keeps root schema alternatives separate when choosing each field's default", async () => {
  const { code, diagnostics } = await generate(
    oas("3.1", {
      paths: {
        "/form": {
          post: operation({
            [form]: {
              schema: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      value: { type: ["object", "string"] },
                      count: { type: "number" },
                    },
                  },
                  {
                    type: "object",
                    properties: { value: { type: "string" }, count: { type: "integer" } },
                  },
                ],
              },
            },
          }),
        },
      },
    }),
  )
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0].message).toContain('form field "value"')
  const generated = await contractOf(code)
  expect(generated.endpoints["POST /form"]?.bodyEncodings?.[form]).toStrictEqual({
    count: { contentType: "text/plain", repeat: true },
  })
})

it("does not infer a field's default from only the alternatives that explicitly name it", async () => {
  const { code, diagnostics } = await generate(
    oas("3.1", {
      paths: {
        "/form": {
          post: operation({
            [form]: {
              schema: {
                anyOf: [
                  { type: "object", properties: { v: { type: "object" } } },
                  { type: "object", additionalProperties: { type: "string" } },
                ],
              },
            },
          }),
        },
      },
    }),
  )
  expect(diagnostics).toMatchObject([
    {
      code: "ignored-field",
      location: "#/paths/~1form/post/requestBody/content/application~1x-www-form-urlencoded/schema",
    },
  ])
  expect(diagnostics[0].message).toContain('form field "v"')
  expect(
    await typecheck({
      "api.ts": code,
      "consumer.ts": `
    import { createClient } from "openapi-shape/client"
    import { contract } from "./api"
    createClient(contract).fetch("POST /form", { body: { v: "x" } })
  `,
    }),
  ).toBe("")
  const generated = await contractOf<{
    "POST /form": { body: Record<typeof form, { v: string }>; responses: object }
  }>(code)
  expect(generated.endpoints["POST /form"]?.bodyEncodings).toBeUndefined()
  const sent: string[] = []
  const api = createClient(generated, {
    baseUrl: "https://api.test",
    fetch: async (request) => {
      sent.push(await request.text())
      return new Response(null, { status: 204 })
    },
  })
  await api.fetch("POST /form", { body: { v: "x" } })
  expect(sent).toStrictEqual(["v=x"])
})

it("treats conditional encoding annotations as unknown and accepts an explicit override", async () => {
  const make = (encoding?: object) =>
    oas("3.1", {
      paths: {
        "/form": {
          post: operation({
            [multipart]: {
              schema: {
                type: "object",
                properties: {
                  v: { type: "string", if: { const: "eA==" }, then: { contentEncoding: "base64" } },
                },
              },
              ...(encoding ? { encoding } : {}),
            },
          }),
        },
      },
    })
  const { code, diagnostics } = await generate(make())
  expect(diagnostics).toMatchObject([
    {
      code: "ignored-field",
      location: "#/paths/~1form/post/requestBody/content/multipart~1form-data/schema",
    },
  ])
  expect(diagnostics[0].message).toContain('form field "v"')
  const inferred = await contractOf(code)
  expect(inferred.endpoints["POST /form"]?.bodyEncodings).toBeUndefined()
  const explicit = await generate(make({ v: { contentType: "application/octet-stream" } }))
  expect(explicit.diagnostics).toStrictEqual([])
  const generated = await contractOf<{
    "POST /form": { body: Record<typeof multipart, { v: string }>; responses: object }
  }>(explicit.code)
  const requests: Request[] = []
  const api = createClient(generated, {
    baseUrl: "https://api.test",
    fetch: (request) => {
      requests.push(request)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  await api.fetch("POST /form", { body: { v: "eA==" } })
  const parts = await requests[0].formData()
  expect(parts.get("v")).toMatchObject({ type: "application/octet-stream" })
  expect(await (parts.get("v") as Blob).text()).toBe("eA==")
})
