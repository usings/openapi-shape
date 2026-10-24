import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { setImmediate } from "node:timers"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DocumentLoader } from "../src/core/index"
import { GenerateError, generate } from "../src/core/index"
import * as rendering from "../src/core/render-types"
import { SchemaBuilder } from "../src/core/schemas"
import { codes, declaration, gen, oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"
import { typecheck } from "./helpers/tsc"

const FIXTURES = join(import.meta.dirname, "fixtures/oai")

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

const load: DocumentLoader = (uri) => {
  if (uri === "https://schemas.test/pet.json") return Response.json(pet)
  throw new Error(`Unknown test resource: ${uri}`)
}

// Advance the cooperative budget deterministically; cancellation itself uses the real event loop.
function clockSlices(): void {
  let now = 0
  vi.spyOn(performance, "now").mockImplementation(() => (now += 8))
}

function endpoints(count: number): object {
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
    const server = createServer((request, response) => {
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
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const { port } = server.address() as AddressInfo
      const { code } = await generate(`http://127.0.0.1:${port}/spec.json`)
      expect(code).toContain("export type A = number")
      await expect(generate(`http://127.0.0.1:${port}/missing`)).rejects.toThrow("HTTP 404")
    } finally {
      server.close()
    }
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
    ["http://json-schema.org/draft-07/schema#", "https://example.com/custom"],
    ["https://example.com/custom", "http://json-schema.org/draft-07/schema#"],
    [undefined, "https://json-schema.org/draft/2020-12/schema"],
  ])("uses 2020-12 semantics with jsonSchemaDialect %s and $schema %s", async (dialect, schema) => {
    const result = await generate(
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
    // In draft-07, items: false forbids every item; 2020-12 lets prefixItems describe the first.
    expect(declaration(result.code, "A")).toBe("[string]")
    expect(result.diagnostics).toStrictEqual([])
  })

  it("accepts every 3.x patch version", async () => {
    const versions = ["3.0.0", "3.0.4", "3.1.0", "3.1.2", "3.2.0", "3.2.1"]
    const outputs = await Promise.all(
      versions.map((openapi) => gen({ openapi, info: { title: "T", version: "1" } })),
    )
    for (const [i, openapi] of versions.entries())
      expect(outputs[i]).toContain(`OpenAPI ${openapi} document`)
  })

  it("writes a header from the document's info", async () => {
    const code = await gen(
      oas("3.1", {
        info: { title: "  Pets\nAPI ", version: "2.0", description: "Line 1\r\nLine 2 */" },
      }),
    )
    expect(code.split("\n\n")[0]).toBe(
      "// Pets API 2.0\n// Line 1\n// Line 2 */\n//\n// Generated by openapi-shape from an OpenAPI 3.1.2 document. Do not edit.",
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
        generate(input, {
          base: "https://schemas.test/api.json",
          load,
        }),
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
    const options = { base: "https://schemas.test/api.json", load }
    const first = await generate(input, options)
    await generate(document({ anyOf: [{ type: "number" }, { type: "string" }] }))
    await expect(generate(document({ $ref: "missing.json" }), options)).rejects.toThrow(
      "Unknown test resource",
    )
    const repeated = await Promise.all(
      [1, 8, 2].map((maxConcurrentLoads) => generate(input, { ...options, maxConcurrentLoads })),
    )
    for (const output of repeated) expect(output).toStrictEqual(first)
    expect(input).toStrictEqual(before)
  })
})

describe("cancellation", () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(["declarations", "operations"] as const)(
    "cancels between %s before building the remaining document",
    async (stage) => {
      clockSlices()
      const count = 200
      const controller = new AbortController()
      const reason = new Error(`cancel ${stage}`)
      const original = SchemaBuilder.prototype.type
      let visited = 0
      const spy = vi.spyOn(SchemaBuilder.prototype, "type").mockImplementation(function (
        this: SchemaBuilder,
        node,
      ) {
        if (++visited === 1) setImmediate(() => controller.abort(reason))
        return original.call(this, node)
      })
      const input =
        stage === "declarations"
          ? oas("3.1", {
              components: {
                schemas: Object.fromEntries(
                  Array.from({ length: count }, (_, i) => [`S${i}`, { type: "string" }]),
                ),
              },
            })
          : endpoints(count)
      await expect(generate(input, { signal: controller.signal })).rejects.toBe(reason)
      expect(visited).toBeGreaterThan(0)
      expect(visited).toBeLessThan(count)
      spy.mockRestore()
      const recovered = await generate(input)
      expect(recovered.diagnostics).toStrictEqual([])
      expect(recovered.code).toContain(stage === "declarations" ? "S199" : "/items/199")
    },
  )

  it("cancels while rendering without returning a partial module, and isolates another run", async () => {
    clockSlices()
    const controller = new AbortController()
    const reason = { cancelled: "render" }
    let rendered = 0
    const original = rendering.renderType
    const spy = vi.spyOn(rendering, "renderType").mockImplementation((type, context) => {
      if (++rendered === 1) setImmediate(() => controller.abort(reason))
      return original(type, context)
    })
    const input = endpoints(200)
    await expect(generate(input, { signal: controller.signal })).rejects.toBe(reason)
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(200)
    spy.mockRestore()
    const [plain, cancellable] = await Promise.all([
      generate(input),
      generate(input, { signal: new AbortController().signal }),
    ])
    expect(cancellable).toStrictEqual(plain)
  })
})
