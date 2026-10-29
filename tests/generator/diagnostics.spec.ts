import { describe, expect, it } from "vitest"
import { GenerateError, generate } from "../../src/core/index"
import { declaration, oas, withSchemas } from "../support/generate"

it("retains input variant naming warnings when another schema prevents generation", async () => {
  const failure: unknown = await generate(
    oas("3.1", {
      components: {
        schemas: {
          User: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", readOnly: true } },
          },
          UserInput: {},
          Broken: { $ref: "#/components/schemas/Missing" },
        },
      },
      paths: {
        "/users": {
          post: {
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
            responses: { "204": {} },
          },
        },
      },
    }),
  ).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(GenerateError)
  if (!(failure instanceof GenerateError)) throw failure
  expect(failure.diagnostics.map(({ code, location }) => ({ code, location }))).toStrictEqual([
    { code: "unresolved-ref", location: "#/components/schemas/Broken/$ref" },
    { code: "renamed-schema", location: "#/components/schemas/User" },
  ])
})

const object = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  properties,
})
const alternatives = (property: string, count: number): Record<string, unknown> => ({
  anyOf: Array.from({ length: count }, (_, value) => object({ [property]: { const: value } })),
})

const intersectingDocument = (count: number) =>
  withSchemas("3.1", {
    T: { allOf: [alternatives("left", count), alternatives("right", 100)] },
  })

describe("schema precision diagnostics", () => {
  it("reports inline widening once at its schema and preserves the existing wider output", async () => {
    const { code, diagnostics } = await generate(
      withSchemas("3.1", {
        Wide: { allOf: [alternatives("left", 101), alternatives("right", 100)] },
      }),
    )
    expect(diagnostics).toMatchObject([
      {
        severity: "warning",
        code: "schema-precision-loss",
        location: "#/components/schemas/Wide",
        message: expect.stringContaining("10,000"),
      },
    ])
    expect(declaration(code, "Wide")).not.toContain("left")
    expect(declaration(code, "Wide")).toContain("right")
  })

  it("reports widening behind completed references at the intersecting schema", async () => {
    const { code, diagnostics } = await generate(
      withSchemas("3.1", {
        Left: alternatives("left", 101),
        Right: alternatives("right", 100),
        Wide: {
          allOf: [{ $ref: "#/components/schemas/Left" }, { $ref: "#/components/schemas/Right" }],
        },
      }),
    )
    expect(diagnostics).toMatchObject([
      {
        code: "schema-precision-loss",
        location: "#/components/schemas/Wide",
      },
    ])
    expect(declaration(code, "Wide")).toBe("{ [key: string]: unknown } & Right")
  })

  it("keeps the exact limit precise and isolates diagnostics across concurrent generations", async () => {
    const [wide, exact] = await Promise.all([
      generate(intersectingDocument(101)),
      generate(intersectingDocument(100)),
    ])
    expect(wide.diagnostics.filter((d) => d.code === "schema-precision-loss")).toHaveLength(1)
    expect(exact.diagnostics).toStrictEqual([])
    expect(declaration(exact.code, "T")).toContain("left")
    expect(declaration(exact.code, "T")).toContain("right")
  })

  it("explains omitted implied constraints without warning about exact scalar intersections", async () => {
    const mixed = {
      anyOf: [
        { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
        ...Array.from({ length: 16 }, (_, n) => ({ const: `s${n}` })),
      ],
    }
    const { diagnostics, code } = await generate(
      withSchemas("3.1", {
        Mixed: mixed,
        Wide: { required: ["extra"], allOf: [{ $ref: "#/components/schemas/Mixed" }] },
        Exact: { required: ["extra"], allOf: [{ type: "string" }] },
        Validation: { type: "string", minLength: 10, pattern: "^[a-z]+$" },
      }),
    )
    expect(diagnostics).toMatchObject([
      {
        code: "schema-precision-loss",
        location: "#/components/schemas/Wide",
        message: expect.stringContaining("implied object or array constraints are omitted"),
      },
    ])
    expect(declaration(code, "Wide")).toBe("Mixed")
    expect(declaration(code, "Exact")).toBe("string")
  })

  it("does not confuse source metadata with schema literal properties", async () => {
    const { code } = await generate(
      withSchemas("3.1", {
        T: { enum: [{ location: "first" }, { location: "second" }] },
      }),
    )
    expect(declaration(code, "T")).toContain('location: "first"')
    expect(declaration(code, "T")).toContain('location: "second"')
  })

  it("reports nested intersections created by merging object fields", async () => {
    const { diagnostics } = await generate(
      withSchemas("3.1", {
        T: {
          allOf: [
            object({ value: alternatives("a", 101) }),
            object({ value: alternatives("b", 100) }),
          ],
        },
      }),
    )
    expect(diagnostics).toMatchObject([
      {
        code: "schema-precision-loss",
        location: "#/components/schemas/T",
      },
    ])
  })
})
