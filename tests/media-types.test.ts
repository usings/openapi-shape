import { describe, expect, it } from "vitest"
import { createClient } from "../src/client"
import { generate } from "../src/core/index"
import { contractOf } from "./helpers/contract"
import { gen, oas } from "./helpers/generate"
import { typecheck } from "./helpers/tsc"

// The rules for media types live in four places that must agree: how the
// generator types content and picks a request's default media type, and how
// the client reads and writes bodies, at run time and in its types. One table
// drives all four.

/** How the client reads a response of a media type. */
type Read = "json" | "text" | "blob"
/**
 * How the client takes a request body of a media type: a value it encodes, a string, or a
 * ready-made body.
 */
type Write = "value" | "string" | "ready"

const MEDIA: Array<[mediaType: string, read: Read, write: Write]> = [
  ["application/json", "json", "value"],
  ["application/problem+json", "json", "value"],
  ["APPLICATION/Problem+JSON; p=*", "json", "value"],
  ["application/vnd.api+json; charset=utf-8", "json", "value"],
  ["text/plain", "text", "string"],
  ["TEXT/PLAIN; charset=utf-8", "text", "string"],
  ["text/csv", "text", "string"],
  ["text/event-stream", "text", "ready"],
  ["application/x-www-form-urlencoded", "blob", "value"],
  ["multipart/form-data", "blob", "value"],
  ["application/jsonl", "blob", "ready"],
  ["application/xml", "blob", "ready"],
  ["application/octet-stream", "blob", "ready"],
  ["image/png", "blob", "ready"],
]

const schema = { type: "object", properties: { a: { type: "string" } } }
const description = oas("3.1", {
  paths: Object.fromEntries(
    MEDIA.map(([mediaType], i) => {
      const content = { [mediaType]: { schema } }
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

describe("media types", () => {
  it("are typed as the client reads and writes them", async () => {
    const code = await gen(description)
    const checks = MEDIA.flatMap(([mediaType, read, write], i) => [
      ...(mediaType === "text/event-stream"
        ? [
            `  // @ts-expect-error SSE is consumed with stream`,
            `  await api.result("GET /m${i}")`,
            `  await api.stream("GET /m${i}", { onMessage(event) { const t: Equal<typeof event.data, string> = true; void t } })`,
          ]
        : [
            `  const r${i} = await api.result("GET /m${i}")`,
            `  if (r${i}.error === undefined) { const t: Equal<typeof r${i}.data, ${READ_TYPE[read]}> = true; void t }`,
          ]),
      // Values the client cannot encode go only as ready-made bodies.
      ...(write === "ready" ? ["  // @ts-expect-error a ready-made body only"] : []),
      `  await api.fetch("POST /m${i}", { body: ${VALUE[write]} })`,
    ])
    const use = [
      'import { createClient } from "openapi-shape/client"',
      'import { contract } from "./api"',
      "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false",
      'const api = createClient(contract, { baseUrl: "https://x.test" })',
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
    for (const [i, [mediaType, , write]] of MEDIA.entries()) {
      const sent: Request[] = []
      const api = createClient(contract, {
        baseUrl: "https://x.test",
        fetch: (request) => {
          sent.push(request)
          const read = MEDIA[i][1]
          const headers = { "content-type": mediaType }
          const body = mediaType === "text/event-stream" ? "data: x\n\n" : BODY[read]
          return Promise.resolve(new Response(body, { status: 200, headers }))
        },
      })
      let data: unknown
      if (mediaType === "text/event-stream") {
        // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
        await api.stream(
          `GET /m${i}` as never,
          {
            onMessage: (event: { data: string }) => {
              data = event.data
            },
          } as never,
        )
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
      const label = await api.fetch(`POST /m${i}`, { body } as never).then(
        () => sent.at(-1)?.headers.get("content-type")?.split(";")[0] ?? "none",
        (error: Error) => (error.message.startsWith("Cannot encode") ? "refused" : error.message),
      )
      observed.push([mediaType, read, label])
    }
    // Sent as the only media type declared, without the call naming it.
    expect(observed).toStrictEqual(
      MEDIA.map(([mediaType, read, write]) => [
        mediaType,
        read,
        write === "ready" ? "refused" : mediaType.split(";")[0],
      ]),
    )
  })
})

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
    baseUrl: "https://x.test",
    fetch: (request) => {
      sent.push(request)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  return { api, sent }
}

describe("the default media type", () => {
  it("is the one the types let a call omit", async () => {
    const code = await gen(defaults)
    const checks = DEFAULTS.flatMap(([mediaTypes, index], i) => {
      const call = (j: number): string => `api.fetch("POST /d${i}", { body: { m${j}: "x" } })`
      if (index === null) {
        return [
          "  // @ts-expect-error no default: the call names a media type",
          `  await ${call(0)}`,
          `  await api.fetch("POST /d${i}", { contentType: ${JSON.stringify(mediaTypes[0])}, body: { m0: "x" } })`,
        ]
      }
      return mediaTypes.flatMap((_, j) =>
        j === index
          ? [`  await ${call(j)}`]
          : ["  // @ts-expect-error a body of another media type names it", `  await ${call(j)}`],
      )
    })
    const use = [
      'import { createClient } from "openapi-shape/client"',
      'import { contract } from "./api"',
      'const api = createClient(contract, { baseUrl: "https://x.test" })',
      "export async function check(): Promise<void> {",
      ...checks,
      "}",
    ].join("\n")
    expect(await typecheck({ "api.ts": code, "use.ts": use })).toBe("")
  })

  it("is the one the client sends, parameters and all", async () => {
    const { api, sent } = await recording(defaults)
    const observed: typeof DEFAULTS = []
    for (const [i, [mediaTypes, index]] of DEFAULTS.entries()) {
      if (index === null) continue
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      await api.fetch(`POST /d${i}`, { body: { [`m${index}`]: "x" } } as never)
      observed.push([mediaTypes, index, sent.at(-1)?.headers.get("content-type") ?? undefined])
    }
    expect(observed).toStrictEqual(DEFAULTS.filter(([, index]) => index !== null))
    // Named by the call too, a `*` in a parameter labels the request.
    const starred = DEFAULTS.findIndex(([[first]]) => first.includes('/*"'))
    const [[mediaType]] = DEFAULTS[starred]
    await api.fetch(`POST /d${starred}`, { contentType: mediaType, body: { m0: "x" } } as never)
    expect(sent.at(-1)?.headers.get("content-type")).toBe(mediaType)
  })

  it("labels the JSON the client encodes, and leaves a ready-made body its own type", async () => {
    const content = { "application/json;charset=UTF-8": {}, "application/octet-stream": {} }
    const upload = { post: { requestBody: { required: true, content }, responses: { "204": {} } } }
    const { api, sent } = await recording(oas("3.1", { paths: { "/upload": upload } }))
    const labels: Array<string | null> = []
    for (const body of [{ a: 1 }, new Blob(["x"], { type: "image/png" }), new Uint8Array([1])]) {
      // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
      await api.fetch("POST /upload", { body } as never)
      labels.push(sent.at(-1)?.headers.get("content-type") ?? null)
    }
    expect(labels).toStrictEqual(["application/json;charset=UTF-8", "image/png", null])
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
            get: { responses: { "200": { description: "OK", content: { [media]: mediaSchema } } } },
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
  if (raw.ok) (await raw.json()).id.toFixed()
}
`,
    }),
  ).toBe("")
})

/** `text/*` content, with `schema` if given. */
const textRange = (value?: object) => ({ "text/*": value ? { schema: value } : {} })

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
  await client.result("POST /any", { body: "text" })
  // @ts-expect-error text is sent as a string
  await client.result("POST /any", { body: { a: 1 } })
}
`,
    }),
  ).toBe("")
})
