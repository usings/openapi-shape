import { expect, it } from "vitest"
import type { DocumentLoader } from "../src/core/index"
import { generate } from "../src/core/index"
import { oas } from "./helpers/generate"
import { typecheck } from "./helpers/tsc"

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
          responses: { "200": { description: "Pet", content: { "application/json": { schema } } } },
        },
      },
    },
  })
}

const load: DocumentLoader = (uri) => {
  if (uri === "https://schemas.test/pet.json") return Response.json(pet)
  throw new Error(`Unknown test resource: ${uri}`)
}

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
const output: E["responses"]["200"]["content"]["application/json"] = { id: 1, name: "pet", location: [1, 2] }
// @ts-expect-error writeOnly secret remains required in a request
const missingSecret: L["body"]["application/json"] = { id: 1, name: "pet", location: [1, 2] }
// @ts-expect-error readOnly id remains required in a response
const missingId: E["responses"]["200"]["content"]["application/json"] = { secret: "s", name: "pet", location: [1, 2] }
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
