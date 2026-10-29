import { expect, it } from "vitest"
import { gen, oas } from "../support/generate"

it("checks schema semantics before folding component aliases", async () => {
  await expect(
    gen(
      oas("3.1", {
        components: {
          schemas: {
            Alias: {
              $schema: "https://example.test/unsupported",
              $ref: "#/components/schemas/Target",
            },
            Target: { type: "string" },
          },
        },
      }),
    ),
  ).rejects.toThrow("Unsupported JSON Schema dialect")
  const { generate } = await import("../../src/core/index")
  const output = await generate(
    oas("3.1", {
      components: {
        schemas: {
          Alias: { $dynamicRef: "#/components/schemas/Target" },
          Target: { type: "string" },
        },
      },
    }),
  )
  expect(
    output.diagnostics.some(
      (d) => d.code === "schema-precision-loss" && d.location.includes("Alias"),
    ),
  ).toBe(true)
})
