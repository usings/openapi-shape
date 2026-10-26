import { expect, it } from "vitest"
import { typecheck } from "./helpers/tsc"

it("compiles cross-file imports and checks both positive and negative type assertions", async () => {
  expect(
    await typecheck({
      "model.ts": "export interface Item { id: number }",
      "use.ts": `import type { Item } from "./model"
const item: Item = { id: 1 }
// @ts-expect-error ids must be numbers
const invalid: Item = { id: "one" }
`,
    }),
  ).toBe("")
  const errors = await typecheck({
    "use.ts": `const value: string = 1
// @ts-expect-error unused directives must fail too
const valid: number = 1
`,
  })
  expect(errors).toContain("TS2322")
  expect(errors).toContain("TS2578")
})

it("checks generated bodies by default and preserves suppression only when requested", async () => {
  const files = { "api.ts": "// @ts-nocheck\nexport const invalid: string = 1\n" }
  expect(await typecheck(files)).toContain("TS2322")
  expect(await typecheck(files, { checkGenerated: false })).toBe("")
})
