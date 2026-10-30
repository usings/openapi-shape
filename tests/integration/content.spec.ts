import { describe, expect, it } from "vitest"
import { createClient } from "../../src/client"
import { collectStreamMedia } from "../../src/client/streams/subscription"
import { generate } from "../../src/core/index"
import { contentTypeErrors } from "../support/content"
import { contractOf } from "../support/contract"
import { codes, entry, gen, oas } from "../support/generate"
import { expectPassesTsc, typecheck } from "../support/tsc"

// The rules for media types live in four places that must agree: how the
// generator describes media and the client selects request encoding, and how
// the client reads and writes bodies, at run time and in its types. One table
// drives all four.

/** How the client reads a response of a media type. */
type Read = "json" | "text" | "blob"

/**
 * How the client takes a request body of a media type: a value it encodes, a string, or a
 * ready-made body.
 */
type Write = "value" | "string" | "ready"

const MEDIA: Array<
  [mediaType: string, read: Read, write: Write, stream?: "sse" | "jsonl" | "json-seq"]
> = [
  ["application/json", "json", "value"],
  ["application/problem+json", "json", "value"],
  ["APPLICATION/Problem+JSON; p=*", "json", "value"],
  ["application/vnd.api+json; charset=utf-8", "json", "value"],
  ["text/plain", "text", "string"],
  ["TEXT/PLAIN; charset=utf-8", "text", "string"],
  ["text/csv", "text", "string"],
  ["text/event-stream", "text", "ready", "sse"],
  ["application/x-www-form-urlencoded", "blob", "value"],
  ["multipart/form-data", "blob", "value"],
  ["application/jsonl", "json", "ready", "jsonl"],
  ["APPLICATION/X-NDJSON; charset=utf-8", "json", "ready", "jsonl"],
  ["application/json-seq", "json", "ready", "json-seq"],
  ["application/example+json-seq", "blob", "ready"],
  ["application/xml", "blob", "ready"],
  ["application/octet-stream", "blob", "ready"],
  ["image/png", "blob", "ready"],
]

const recordSchema = { type: "object", properties: { a: { type: "string" } } }

const description = oas("3.1", {
  paths: Object.fromEntries(
    MEDIA.map(([mediaType, , , stream], i) => {
      const content = {
        [mediaType]: {
          schema:
            stream && stream !== "sse" ? { type: "array", items: recordSchema } : recordSchema,
        },
      }
      return [
        `/m${i}`,
        {
          get: { responses: { "200": { content } } },
          post: { requestBody: { required: true, content }, responses: { "204": {} } },
        },
      ]
    }),
  ),
})

/** What a call that reads the response resolves `data` to, as TypeScript. */
const READ_TYPE: Record<Read, string> = { json: "{ a?: string }", text: "string", blob: "Blob" }

/** A response body of each kind, and a request value of each. */
const BODY: Record<Read, string> = { json: '{"a":"x"}', text: "x", blob: "x" }

const VALUE: Record<Write, string> = { value: '{ a: "x" }', string: '"x"', ready: '{ a: "x" }' }

// The media type a body is sent as when the call names none: the declared
// `application/json` one, parameters and all, where one alone is; else the
// only one declared; else none, and the call names one. The types, the
// contract, and the client must agree on it.
const DEFAULTS: Array<[mediaTypes: string[], index: number | null, sent?: string]> = [
  [
    ['application/json; profile="https://x.test/p"'],
    0,
    'application/json; profile="https://x.test/p"',
  ],
  // A `*` in a parameter is no wildcard.
  [
    ['application/json; profile="https://x.test/*"'],
    0,
    'application/json; profile="https://x.test/*"',
  ],
  [["application/json", "*/*"], 0, "application/json"],
  [["application/xml", "application/json"], 1, "application/json"],
  [["application/merge-patch+json"], 0, "application/merge-patch+json"],
  // A wildcard cannot label a request: its JSON goes as application/json.
  [["*/*"], 0, "application/json"],
  [["Application/*"], 0, "application/json"],
  [[" \tApplication/JSON ; charset=utf-8"], 0, "Application/JSON ; charset=utf-8"],
  [["application/json", "application/json; charset=utf-8"], null],
  // Spaces and tabs around the type count alike (RFC 9110, OWS).
  [["application/json; charset=utf-8", "application/json\t;v=2"], null],
  [["*/*", "text/plain"], null],
]

/** One required property per media type, so that a body is of one of them. */
const property = (j: number): object => ({
  type: "object",
  required: [`m${j}`],
  properties: { [`m${j}`]: { type: "string" } },
})

const defaults = oas("3.1", {
  paths: Object.fromEntries(
    DEFAULTS.map(([mediaTypes], i) => [
      `/d${i}`,
      {
        post: {
          requestBody: {
            required: true,
            content: Object.fromEntries(mediaTypes.map((m, j) => [m, { schema: property(j) }])),
          },
          responses: { "204": {} },
        },
      },
    ]),
  ),
})

/** A client of the module generated from `document`, recording what it sends. */
async function recording(document: object) {
  const code = await gen(document)
  const contract = await contractOf(code)
  const sent: Request[] = []
  const api = createClient(contract, {
    baseURL: "https://x.test",
    fetch: (request) => {
      sent.push(request)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  return { api, sent }
}

/** `text/*` content, with `schema` if given. */
const textRange = (value?: object) => ({ "text/*": value ? { schema: value } : {} })

describe("media types", () => {
  it("are typed as the client reads and writes them", async () => {
    const code = await gen(description)
    const checks = MEDIA.flatMap(([mediaType, read, write, stream], i) => [
      ...(stream
        ? [
            `  // @ts-expect-error sequential responses are consumed with stream`,
            `  await api.result("GET /m${i}")`,
            `  for await (const item of api.stream("GET /m${i}")) { const t: Equal<typeof ${stream === "sse" ? "item.data" : "item"}, ${READ_TYPE[read]}> = true; void t }`,
          ]
        : [
            `  const r${i} = await api.result("GET /m${i}")`,
            `  if (r${i}.error === undefined) { const t: Equal<typeof r${i}.data, ${READ_TYPE[read]}> = true; void t }`,
          ]),
      // Values the client cannot encode go only as ready-made bodies.
      ...(write === "ready" ? ["  // @ts-expect-error a ready-made body only"] : []),
      `  await api.fetch("POST /m${i}", { headers: { "content-type": ${JSON.stringify(mediaType)} }, body: ${VALUE[write]} })`,
    ])
    const use = [
      'import { createClient } from "openapi-shape/client"',
      'import { contract } from "./api"',
      "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false",
      'const api = createClient(contract, { baseURL: "https://x.test" })',
      "export async function check(): Promise<void> {",
      ...checks,
      "}",
    ].join("\n")
    expect(await typecheck({ "api.ts": code, "use.ts": use })).toBe("")
  })

  it("are read and written at run time as their types say", async () => {
    const code = await gen(description)
    const contract = await contractOf(code)
    // What the client did with each: how it read the response, and what it labelled a request.
    const observed: Array<[string, string, string]> = []
    for (const [i, [mediaType, , write, stream]] of MEDIA.entries()) {
      const sent: Request[] = []
      const api = createClient(contract, {
        baseURL: "https://x.test",
        fetch: (request) => {
          sent.push(request)
          const read = MEDIA[i][1]
          const headers = { "content-type": mediaType }
          const body =
            stream === "sse"
              ? "data: x\n\n"
              : stream === "json-seq"
                ? `\x1e${BODY[read]}\n`
                : BODY[read]
          return Promise.resolve(new Response(body, { status: 200, headers }))
        },
      })
      let data: unknown
      if (stream) {
        // oxlint-disable-next-line no-await-in-loop -- consume each independent finite stream
        for await (const item of api.stream(
          `GET /m${i}` as never,
          (stream === "sse" ? { reconnect: false } : {}) as never,
        )) {
          data = stream === "sse" ? (item as { data: string }).data : item
        }
      } else {
        // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
        const result = await api.result(`GET /m${i}`)
        data = result.data
      }
      const read =
        data instanceof Blob
          ? "blob"
          : data === "x"
            ? "text"
            : JSON.stringify(data) === '{"a":"x"}'
              ? "json"
              : JSON.stringify(data)
      const body = write === "string" ? "x" : { a: "x" }
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      const label = await api
        .fetch(`POST /m${i}`, { headers: { "content-type": mediaType }, body } as never)
        .then(
          () => sent.at(-1)?.headers.get("content-type")?.split(";")[0] ?? "none",
          (error: Error) => (error.message.startsWith("Cannot encode") ? "refused" : error.message),
        )
      observed.push([mediaType, read, label])
    }
    // Explicit headers select each declared representation; ready-only media reject structured values.
    expect(observed).toStrictEqual(
      MEDIA.map(([mediaType, read, write]) => [
        mediaType,
        read,
        write === "ready" ? "refused" : mediaType.split(";")[0],
      ]),
    )
  })

  describe("explicit request media", () => {
    it("requires an explicit header when JSON fallback cannot satisfy media parameters", async () => {
      const code = await gen(defaults)
      expect(
        await typecheck({
          "api.ts": code,
          "use.ts": `
        import { createClient } from "openapi-shape/client"
        import { contract } from "./api"
        const api = createClient(contract)
        // @ts-expect-error the JSON fallback does not include the required profile parameter
        api.fetch("POST /d0", { body: { m0: "x" } })
        api.fetch("POST /d0", { headers: { "content-type": 'application/json; profile="https://x.test/p"' }, body: { m0: "x" } })
      `,
        }),
      ).toBe("")
    })
    it("does not infer a default from the declaration set", async () => {
      const { api, sent } = await recording(defaults)
      await expect(api.fetch("POST /d0", { body: { m0: "x" } } as never)).rejects.toThrow(
        "Content-Type",
      )
      expect(sent).toHaveLength(0)
      await api.fetch("POST /d0", {
        headers: { "content-type": 'application/json; profile="https://x.test/p"' },
        body: { m0: "x" },
      } as never)
      expect(sent[0].headers.get("content-type")).toBe(
        'application/json; profile="https://x.test/p"',
      )
    })
  })

  it("requires narrowing wildcard results before accessing schema properties", async () => {
    const mediaSchema = {
      schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
    }
    const { code } = await generate(
      oas("3.1", {
        paths: Object.fromEntries(
          ["application/*", "*/*", "application/json"].map((media, i) => [
            `/r${i}`,
            {
              get: {
                responses: { "200": { description: "OK", content: { [media]: mediaSchema } } },
              },
            },
          ]),
        ),
      }),
    )
    expect(
      await typecheck({
        "api.ts": code,
        "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const client = createClient(contract)
async function check() {
  const app = await client.result("GET /r0")
  if (app.error === undefined) {
    app.data satisfies { id: number } | Blob
    // @ts-expect-error application/* may return a Blob
    app.data.id.toFixed()
    if (!(app.data instanceof Blob)) app.data.id.toFixed()
  }
  const any = await client.result("GET /r1")
  if (any.error === undefined) {
    any.data satisfies { id: number } | Blob | string
    // @ts-expect-error */* may also return text
    any.data.id.toFixed()
    if (typeof any.data !== "string" && !(any.data instanceof Blob)) any.data.id.toFixed()
  }
  const json = await client.result("GET /r2")
  if (json.error === undefined) json.data.id.toFixed()
  const raw = await client.fetch("GET /r0")
  // @ts-expect-error wildcard media do not establish the parsed JSON shape
  if (raw.status === 200) (await raw.json()).id.toFixed()
}
`,
      }),
    ).toBe("")
  })

  it("types a text/* response as JSON or text, and its request body as text", async () => {
    const { code } = await generate(
      oas("3.1", {
        paths: {
          "/any": {
            get: { responses: { "200": { description: "OK", content: textRange() } } },
            post: { requestBody: { content: textRange() }, responses: { "204": {} } },
          },
          "/strings": {
            get: {
              responses: { "200": { description: "OK", content: textRange({ type: "string" }) } },
            },
          },
        },
      }),
    )
    expect(
      await typecheck({
        "api.ts": code,
        "use.ts": `
import { createClient } from "openapi-shape/client"
import { contract } from "./api"
const client = createClient(contract)
async function check() {
  const any = await client.result("GET /any")
  if (any.error === undefined) {
    // @ts-expect-error a text/json response is parsed
    any.data.toUpperCase()
    if (typeof any.data === "string") any.data.toUpperCase()
  }
  const strings = await client.result("GET /strings")
  if (strings.error === undefined) strings.data.toUpperCase()
  await client.result("POST /any", { body: "text", headers: { "content-type": "text/plain" } })
  // @ts-expect-error text is sent as a string
  await client.result("POST /any", { body: { a: 1 }, headers: { "content-type": "application/json" } })
}
`,
      }),
    ).toBe("")
  })
  describe("response media schemas", () => {
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
      expect(await contentTypeErrors(media, schema, expected)).toBe("")
    })

    const object = { type: "object", properties: { id: { type: "integer" } } }

    it.each([
      ["text/json", object, "{ id?: number }"],
      ["*/*", { type: "integer" }, "number | string | Blob"],
      ["text/csv", { type: "string" }, "string"],
      ["text/plain", { type: "integer" }, "string"],
      ["text/plain", { oneOf: [{ type: "integer" }, { type: "boolean" }] }, "string"],
      ["text/plain", { enum: ["ok", "no"] }, '"ok" | "no"'],
      ["text/*", { enum: ["ok", "no"] }, '"ok" | "no"'],
      ["text/*", object, "unknown"],
      ["application/vnd.github.diff", { type: "string" }, "Blob"],
      ["image/png", { type: "string", format: "binary" }, "Blob"],
    ])("%s decodes according to the response media", async (media, schema, expected) => {
      expect(await contentTypeErrors(media, { schema }, expected)).toBe("")
    })
  })

  it("keeps referenced text literals in decoded responses", async () => {
    const { code } = await generate(
      oas("3.2", {
        components: { schemas: { Word: { type: "string", enum: ["ok", "no"] } } },
        paths: {
          "/text": {
            get: {
              responses: {
                "200": {
                  content: { "text/plain": { schema: { $ref: "#/components/schemas/Word" } } },
                },
              },
            },
          },
        },
      }),
    )
    await expectPassesTsc(
      code,
      `
import {createClient} from "openapi-shape/client"
import {contract} from "./file0"
const api=createClient(contract)
const result=await api.result("GET /text")
if (result.error === undefined) result.data satisfies "ok" | "no"
`,
    )
  })
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
      await contentTypeErrors(
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
for await (const item of api.stream("POST /r", { body: "1\\n2\\n", headers: { "content-type": "application/x-ndjson" } })) {
  item satisfies number
}
// @ts-expect-error sequences require encoded text or a ready body
void api.stream("POST /r", { body: [1, 2], headers: { "content-type": "application/json" } })
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
  ])("distinguishes whole sequence schemas from item schemas: %j", async (schema, expected) => {
    for (const media of ["application/x-ndjson", "application/json-seq"]) {
      // oxlint-disable-next-line no-await-in-loop -- each media independently checks generated item types
      expect(await contentTypeErrors(media, schema, expected, "3.2", "EndpointStreamItem")).toBe("")
    }
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
    expect(collectStreamMedia(endpoints["GET /streams"])).toStrictEqual([
      jsonl,
      sse,
      ndjson,
      "application/json-seq",
    ])
    expect(collectStreamMedia(endpoints["GET /fallback"])).toStrictEqual([ndjson])
    expect(Object.keys(endpoints["HEAD /head"].responses)).toStrictEqual(["200"])
    expect(collectStreamMedia(endpoints["GET /shadowed"])).toStrictEqual([])
  })
})
