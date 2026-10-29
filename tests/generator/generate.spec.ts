import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { setImmediate } from "node:timers"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DocumentLoader } from "../../src/core/index"
import { GenerateError, generate } from "../../src/core/index"
import { contractOf } from "../support/contract"
import { codes, declaration, documentSource, gen, oas } from "../support/generate"
import { withServer } from "../support/http"
import { withFiles } from "../support/tmp"
import { typecheck } from "../support/tsc"

const FIXTURES = join(import.meta.dirname, "../fixtures/oai")

/** Diagnostic codes of a failed generation. */
async function failureCodes(input: string | object): Promise<string[]> {
  const failure: unknown = await generate(input).catch((error: unknown) => error)
  return codes((failure as GenerateError).diagnostics)
}

const pet = {
  type: "object",
  required: ["id", "secret", "name", "location"],
  properties: {
    id: { type: "integer", readOnly: true },
    secret: { type: "string", writeOnly: true },
    name: { type: ["string", "null"] },
    location: {
      type: "array",
      prefixItems: [{ type: "number" }, { type: "number" }],
      minItems: 2,
      items: false,
    },
  },
}

function document(schema: object, schemas: Record<string, object> = {}) {
  return oas("3.1", {
    components: { schemas },
    paths: {
      "/pets": {
        post: {
          requestBody: { required: true, content: { "application/json": { schema } } },
          responses: {
            "200": { description: "Pet", content: { "application/json": { schema } } },
          },
        },
      },
    },
  })
}

const loader: DocumentLoader = (uri) => {
  if (uri === "https://schemas.test/pet.json") return Response.json(pet)
  throw new Error(`Unknown test resource: ${uri}`)
}

// Advance the cooperative budget deterministically; cancellation itself uses the real event loop.
function clockSlices(): void {
  let now = 0
  vi.spyOn(performance, "now").mockImplementation(() => (now += 8))
}

function operations(count: number): object {
  return oas("3.1", {
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `/items/${i}`,
        {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": { schema: { type: "string" } },
                },
              },
            },
          },
        },
      ]),
    ),
  })
}

describe("generation", () => {
  it.each(["@ts-check", "@TS-CHECK", "@Ts-Check"])(
    "keeps metadata from overriding compiler and linter directives: %s",
    async (check) => {
      const directives = [
        "@ts-nocheck",
        "eslint-enable",
        "biome-ignore-all format: metadata",
        "oxlint-enable",
        "prettier-ignore",
        "oxfmt-ignore",
        check,
      ]
      const code = await gen(
        oas("3.1", {
          info: { title: "@ts-check", description: directives.join("\r\n") },
        }),
      )
      for (const directive of directives) expect(code).toContain(`// | ${directive}\n`)
      expect(
        await typecheck(
          { "api.ts": `${code}\nexport const invalid: string = 1\n` },
          { checkGenerated: false },
        ),
      ).toBe("")
    },
  )

  it("generates an importable empty contract", async () => {
    const code = await gen(oas("3.1"))
    expect(await contractOf(code)).toStrictEqual({ version: 7, endpoints: {} })
  })

  it("accepts paths, file URLs, and parsed documents alike", async () => {
    const path = join(FIXTURES, "v3.0/petstore.yaml")
    const [fromPath, fromUrl, fromJson, fromParsed] = await Promise.all([
      generate(path),
      generate(pathToFileURL(path)),
      generate(join(FIXTURES, "v3.0/petstore.json")),
      generate(JSON.parse(await readFile(join(FIXTURES, "v3.0/petstore.json"), "utf8"))),
    ])
    expect(fromUrl.code).toBe(fromPath.code)
    expect(fromJson.code).toBe(fromPath.code)
    expect(fromParsed.code).toBe(fromPath.code)
  })

  it("lets HTTP Content-Type override the path when parsing documents", async () => {
    await withServer(
      (request, response) => {
        if (request.url === "/spec.json") {
          response.setHeader("content-type", "application/yaml")
          response.end(
            "openapi: 3.1.0\ninfo: { title: T, version: '1' }\ncomponents:\n  schemas:\n    A: { $ref: 'a.json' }\n",
          )
        } else if (request.url === "/a.json") {
          response.setHeader("content-type", "application/json")
          response.end('{"type":"integer"}')
        } else {
          response.statusCode = 404
          response.end()
        }
      },
      async (origin) => {
        const { code } = await generate(`${origin}/spec.json`)
        expect(code).toContain("export type A = number")
        await expect(generate(`${origin}/missing`)).rejects.toThrow("HTTP 404")
      },
    )
  })

  it.each([
    [{ swagger: "2.0" }, "unsupported-version #/swagger"],
    [{ info: {} }, "unsupported-version #/openapi"],
    [{ openapi: "3.3.0" }, "unsupported-version #/openapi"],
    [{ openapi: 3.1 }, "unsupported-version #/openapi"],
  ])("rejects %j", async (doc, expected) => {
    const failure: unknown = await generate(doc).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GenerateError)
    expect(codes((failure as GenerateError).diagnostics)).toStrictEqual([expected])
  })

  it("rejects documents that are not objects or cannot be read or parsed", async () => {
    expect(await failureCodes([])).toStrictEqual(["invalid-document #"])
    expect(await failureCodes("/does/not/exist.yaml")).toStrictEqual(["read-failed #"])
    await withFiles({ "bad.yaml": "openapi: [unclosed" }, async (dir) => {
      expect(await failureCodes(join(dir, "bad.yaml"))).toStrictEqual(["read-failed #"])
    })
  })

  it.each([
    ["https://json-schema.org/draft/2020-12/schema", undefined],
    [undefined, "https://json-schema.org/draft/2020-12/schema"],
  ])("uses 2020-12 semantics with jsonSchemaDialect %s and $schema %s", async (dialect, schema) => {
    const pending = generate(
      oas("3.1", {
        ...(dialect === undefined ? {} : { jsonSchemaDialect: dialect }),
        components: {
          schemas: {
            A: {
              ...(schema === undefined ? {} : { $schema: schema }),
              type: "array",
              prefixItems: [{ type: "string" }],
              minItems: 1,
              items: false,
            },
          },
        },
      }),
    )
    const result = await pending
    // In draft-07, items: false forbids every item; 2020-12 lets prefixItems describe the first.
    expect(declaration(result.code, "A")).toBe("[string]")
    expect(result.diagnostics).toStrictEqual([])
  })

  it.each(["http://json-schema.org/draft-07/schema#", "https://example.com/custom"])(
    "rejects unsupported schema dialect %s",
    async (dialect) => {
      await expect(generate(oas("3.1", { jsonSchemaDialect: dialect }))).rejects.toThrow(
        "Unsupported JSON Schema dialect",
      )
      await expect(
        generate(
          oas("3.1", { components: { schemas: { A: { $schema: dialect, type: "string" } } } }),
        ),
      ).rejects.toThrow("Unsupported JSON Schema dialect")
    },
  )

  it("accepts every 3.x patch version", async () => {
    const versions = ["3.0.0", "3.0.4", "3.1.0", "3.1.2", "3.2.0", "3.2.1"]
    const outputs = await Promise.all(
      versions.map((openapi) => gen({ openapi, info: { title: "T", version: "1" } })),
    )
    for (const [i, openapi] of versions.entries())
      expect(outputs[i]).toContain(`// @version ${openapi}\n`)
  })

  it("writes a header from the document's info", async () => {
    const code = await gen(
      oas("3.1", {
        info: { title: "  Pets\nAPI ", version: "2.0", description: "Line 1\r\nLine 2 */" },
        servers: [{ url: "https://{region}.api.test/v1" }, { url: "https://backup.api.test/v1" }],
      }),
    )
    expect(code.split("\n\n")[0]?.split(/^\/\/ -+\n/m)[1]).toBe(
      "// Pets API 2.0\n// Line 1\n// Line 2 */\n// @version 3.1.2\n// @server https://{region}.api.test/v1\n// @server https://backup.api.test/v1\n",
    )
  })
})

describe("generation equivalence", () => {
  it("preserves request and response meaning across inline, local and external schemas", async () => {
    const variants = [
      document(pet),
      document({ $ref: "#/components/schemas/Pet" }, { Pet: pet }),
      document({ $ref: "pet.json" }),
    ]
    const outputs = await Promise.all(
      variants.map((input) =>
        generate(...documentSource(input, "https://schemas.test/api.json", { loader })),
      ),
    )
    for (const output of outputs) expect(output.diagnostics).toStrictEqual([])
    expect(
      await typecheck(
        {
          ...Object.fromEntries(outputs.map((output, i) => [`api${i}.ts`, output.code])),
          "use.ts": `
import type { Endpoints as Inline } from "./api0"
import type { Endpoints as Local } from "./api1"
import type { Endpoints as External } from "./api2"
type I = Inline["POST /pets"]
type L = Local["POST /pets"]
type E = External["POST /pets"]
export const localForward: [I] extends [L] ? true : false = true
export const localBackward: [L] extends [I] ? true : false = true
export const externalForward: [I] extends [E] ? true : false = true
export const externalBackward: [E] extends [I] ? true : false = true
// Concrete witnesses keep equivalent but accidentally over-wide results from passing.
const input: I["body"]["application/json"] = { secret: "s", name: null, location: [1, 2] }
const output: E["responses"][200]["content"]["application/json"] = { id: 1, name: "pet", location: [1, 2] }
// @ts-expect-error writeOnly secret remains required in a request
const missingSecret: L["body"]["application/json"] = { id: 1, name: "pet", location: [1, 2] }
// @ts-expect-error readOnly id remains required in a response
const missingId: E["responses"][200]["content"]["application/json"] = { secret: "s", name: "pet", location: [1, 2] }
// @ts-expect-error the tuple is closed
const longLocation: I["body"]["application/json"] = { secret: "s", name: "pet", location: [1, 2, 3] }
`,
        },
        { compilerOptions: { exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true } },
      ),
    ).toBe("")
  })

  it("generates identical bytes after other generations, a failure and concurrent calls", async () => {
    const input = document({ $ref: "pet.json" })
    const before = structuredClone(input)
    const options = { loader }
    const first = await generate(...documentSource(input, "https://schemas.test/api.json", options))
    await generate(document({ anyOf: [{ type: "number" }, { type: "string" }] }))
    await expect(
      generate(
        ...documentSource(
          document({ $ref: "missing.json" }),
          "https://schemas.test/api.json",
          options,
        ),
      ),
    ).rejects.toThrow("Unknown test resource")
    const repeated = await Promise.all(
      [1, 8, 2].map((maxConcurrentLoads) =>
        generate(
          ...documentSource(input, "https://schemas.test/api.json", {
            ...options,
            maxConcurrentLoads,
          }),
        ),
      ),
    )
    for (const output of repeated) expect(output).toStrictEqual(first)
    expect(input).toStrictEqual(before)
  })
})

describe("cancellation", () => {
  afterEach(() => vi.restoreAllMocks())

  it("keeps in-memory generation off the event loop when no signal is supplied", async () => {
    clockSlices()
    let yielded = false
    const timer = setImmediate(() => {
      yielded = true
    })
    try {
      const result = await generate(operations(200))
      expect(result.diagnostics).toStrictEqual([])
      expect(result.code).toContain('"GET /items/199"')
      expect(yielded).toBe(false)
    } finally {
      clearImmediate(timer)
    }
  })

  it.each([false, true])(
    "interrupts CPU work and isolates concurrent generations (other cancellable: %s)",
    async (cancellable) => {
      clockSlices()
      const controller = new AbortController()
      const other = new AbortController()
      const reason = { cancelled: "generation" }
      const input = operations(200)
      const before = structuredClone(input)
      const pending = generate(input, { signal: controller.signal })
      const timer = setImmediate(() => controller.abort(reason))
      try {
        const [cancelled, complete] = await Promise.allSettled([
          pending,
          generate(input, cancellable ? { signal: other.signal } : {}),
        ])
        expect(cancelled).toStrictEqual({ status: "rejected", reason })
        expect(complete.status).toBe("fulfilled")
        expect(other.signal.aborted).toBe(false)
        const recovered = await generate(input)
        expect(complete).toStrictEqual({ status: "fulfilled", value: recovered })
        expect(recovered.diagnostics).toStrictEqual([])
        expect(input).toStrictEqual(before)
      } finally {
        clearImmediate(timer)
      }
    },
  )
})
