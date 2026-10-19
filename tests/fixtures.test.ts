import { readdirSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import type { GenerateResult } from "../src/index"
import { generate } from "../src/index"
import { typecheck } from "./helpers/tsc"

// Official OpenAPI Initiative examples for every supported version.
const ROOT = join(import.meta.dirname, "fixtures/oai")
const fixtures = ["v3.0", "v3.1", "v3.2"].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => `${dir}/${file}`),
)

describe("OpenAPI Initiative examples", () => {
  let results: Record<string, GenerateResult>
  beforeAll(async () => {
    results = Object.fromEntries(
      await Promise.all(
        fixtures.map(async (fixture) => [fixture, await generate(join(ROOT, fixture))]),
      ),
    )
  })
  it.each(fixtures)("%s", async (fixture) => {
    const { code, diagnostics } = results[fixture]
    expect(diagnostics).toStrictEqual([])
    await expect(code).toMatchFileSnapshot(`__snapshots__/oai/${fixture.replace(/\.yaml$/, ".ts")}`)
  })

  it("all compile together", async () => {
    const files = Object.fromEntries(
      fixtures.map((fixture) => [`${fixture.replaceAll(/[/.]/g, "_")}.ts`, results[fixture].code]),
    )
    expect(await typecheck(files)).toBe("")
  })
})

// The module the client runtime and type tests use: the generator's real output.
it("generates the client fixture", async () => {
  const { code, diagnostics } = await generate(join(import.meta.dirname, "fixtures/client.yaml"))
  expect(diagnostics).toStrictEqual([])
  await expect(code).toMatchFileSnapshot("__snapshots__/client-api.ts")
})
