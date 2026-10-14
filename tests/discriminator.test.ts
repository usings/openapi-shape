import { describe, expect, it } from "vitest"
import { codes, declaration, gen, genResult, withSchemas } from "./helpers/generate"
import { expectPassesTsc } from "./helpers/tsc"

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
})

describe("discriminated oneOf/anyOf", () => {
  it("narrows each referenced branch at the union, by mapping or by component name", async () => {
    const code = await gen(
      withSchemas("3.1", {
        Cat: object({ kind: { type: "string" }, purrs: { type: "boolean" } }, ["kind"]),
        Dog: object({ kind: { type: "string" } }),
        Pet: {
          oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
          discriminator: {
            propertyName: "kind",
            mapping: { cat: "#/components/schemas/Cat", kitty: "Cat" },
          },
        },
        Other: {
          anyOf: [{ $ref: "#/components/schemas/Cat" }],
          discriminator: { propertyName: "kind" },
        },
      }),
    )
    expect(declaration(code, "Pet")).toBe(
      '(Cat & { kind: "cat" | "kitty" }) | (Dog & { kind: "Dog" })',
    )
    // The component itself is not changed: the values belong to the union.
    expect(declaration(code, "Cat")).toBe("{\n  kind: string\n  purrs?: boolean\n}")
    expect(declaration(code, "Other")).toBe('Cat & { kind: "Cat" }')
    await expectPassesTsc(code)
  })

  it("lets the schema's own literals win", async () => {
    const result = await genResult(
      withSchemas("3.1", {
        Auto: object({ type: { type: "string", enum: ["auto"] } }, ["type"]),
        Static: object({ type: { const: "static" } }, ["type"]),
        Manual: object({ type: { enum: ["manual", "custom"] } }, ["type"]),
        Strategy: {
          oneOf: ["Auto", "Static", "Manual"].map((n) => ({ $ref: `#/components/schemas/${n}` })),
          // Implicit names ("Auto") disagree with the declared literals; that is not reported.
          discriminator: { propertyName: "type", mapping: { custom: "Manual", wrong: "Static" } },
        },
      }),
    )
    expect(declaration(result.code, "Strategy")).toBe(
      'Auto | Static | (Manual & { type: "custom" })',
    )
    expect(codes(result.diagnostics)).toStrictEqual([
      "discriminator-mismatch #/components/schemas/Strategy/oneOf/1",
    ])
  })

  it("leaves non-object branches alone and reports them", async () => {
    const result = await genResult(
      withSchemas("3.1", {
        List: { type: "array", items: { type: "string" } },
        Item: object({ type: { type: "string" } }),
        Content: {
          oneOf: [{ $ref: "#/components/schemas/List" }, { $ref: "#/components/schemas/Item" }],
          discriminator: {
            propertyName: "type",
            mapping: { array: "#/components/schemas/List", file: "#/components/schemas/Item" },
          },
        },
      }),
    )
    expect(declaration(result.code, "Content")).toBe('List | (Item & { type: "file" })')
    expect(codes(result.diagnostics)).toStrictEqual([
      "discriminator-mismatch #/components/schemas/Content/oneOf/0",
    ])
  })

  it("does not narrow inline branches or the defaultMapping target (3.2)", async () => {
    const code = await gen(
      withSchemas("3.2", {
        Known: object({ type: { type: "string" } }),
        Fallback: object({ type: { type: "string" } }),
        T: {
          oneOf: [
            { $ref: "#/components/schemas/Known" },
            { $ref: "#/components/schemas/Fallback" },
            object({ x: { type: "string" } }),
          ],
          discriminator: { propertyName: "type", defaultMapping: "Fallback" },
        },
      }),
    )
    expect(declaration(code, "T")).toBe('(Known & { type: "Known" }) | Fallback | { x?: string }')
  })
})

describe("discriminated allOf hierarchies", () => {
  it("narrows each component that extends the parent", async () => {
    const code = await gen(
      withSchemas("3.0", {
        Pet: {
          ...object({ petType: { type: "string" }, name: { type: "string" } }, ["petType"]),
          discriminator: { propertyName: "petType", mapping: { dog: "Dog" } },
        },
        Cat: {
          allOf: [{ $ref: "#/components/schemas/Pet" }, object({ purrs: { type: "boolean" } })],
        },
        Dog: {
          allOf: [{ $ref: "#/components/schemas/Pet" }, object({ barks: { type: "boolean" } })],
        },
        Lion: { allOf: [{ $ref: "#/components/schemas/Cat" }] },
      }),
    )
    expect(declaration(code, "Pet")).toBe("{\n  petType: string\n  name?: string\n}")
    // A Lion is also a Cat, so Cat admits Lion's value too.
    expect(declaration(code, "Cat")).toBe('Pet & { purrs?: boolean; petType: "Cat" | "Lion" }')
    expect(declaration(code, "Dog")).toBe('Pet & { barks?: boolean; petType: "dog" }')
    expect(declaration(code, "Lion")).toBe('Cat & { petType: "Lion" }')
  })
})

describe("discriminators that cannot apply", () => {
  it("leaves non-string properties alone, and keeps a branch's non-object values", async () => {
    const result = await genResult(
      withSchemas("3.1", {
        Pet: {
          oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
          discriminator: { propertyName: "kind" },
        },
        Cat: { type: ["object", "null"], properties: { kind: { type: "string" } } },
        Dog: { type: "object", required: ["kind"], properties: { kind: { type: "integer" } } },
      }),
    )
    expect(declaration(result.code, "Pet")).toBe('(Cat & { kind: "Cat" }) | null | Dog')
    expect(codes(result.diagnostics)).toStrictEqual([
      "discriminator-mismatch #/components/schemas/Pet/oneOf/1",
    ])
    await expectPassesTsc(
      result.code,
      'import type { Schemas } from "./file0"\nexport const p: Schemas.Pet[] = [null, { kind: 1 }, { kind: "Cat" }]\n',
    )
  })
})
