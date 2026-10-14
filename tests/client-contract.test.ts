import { join } from "node:path"
import { expect, it } from "vitest"
import { generate } from "../src/index"

// The declarations client.test.ts type-checks against: the generator's real output.
it("generates the client fixture contract", async () => {
  const { code, diagnostics } = await generate(join(import.meta.dirname, "fixtures/client.yaml"))
  expect(diagnostics).toStrictEqual([])
  await expect(code).toMatchFileSnapshot("__snapshots__/client-api.ts")
})
