import { setImmediate } from "node:timers"
import { afterEach, expect, it, vi } from "vitest"
import { generate } from "../src/core/index"
import * as rendering from "../src/core/render-types"
import { SchemaBuilder } from "../src/core/schemas"
import { oas } from "./helpers/generate"

afterEach(() => vi.restoreAllMocks())

// Advance the cooperative budget deterministically; cancellation itself uses the real event loop.
function clockSlices(): void {
  let now = 0
  vi.spyOn(performance, "now").mockImplementation(() => (now += 8))
}

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
