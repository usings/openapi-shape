import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
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
  it.each(fixtures)("%s", async (fixture) => {
    const { code, diagnostics } = await generate(join(ROOT, fixture))
    expect(diagnostics).toStrictEqual([])
    await expect(code).toMatchFileSnapshot(`__snapshots__/oai/${fixture.replace(/\.yaml$/, ".ts")}`)
  })

  it("all compile together", async () => {
    const results = await Promise.all(fixtures.map((fixture) => generate(join(ROOT, fixture))))
    const files = Object.fromEntries(
      fixtures.map((fixture, i) => [`${fixture.replaceAll(/[/.]/g, "_")}.ts`, results[i].code]),
    )
    expect(await typecheck(files)).toBe("")
  })
})
