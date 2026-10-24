import { expect, it } from "vitest"
import type { Declaration, Type } from "../src/core/model"
import { UNKNOWN } from "../src/core/model"
import { intersect, union } from "../src/core/type-algebra"

it("treats binary as a string annotation while preserving file projections", () => {
  const binary: Type = { kind: "binary" }
  const string: Type = { kind: "string" }
  const value: Type = { kind: "literal", value: "abc" }
  expect(intersect([binary, string])).toStrictEqual(binary)
  expect(intersect([string, binary])).toStrictEqual(binary)
  expect(intersect([binary, value])).toStrictEqual(value)
  expect(intersect([value, binary])).toStrictEqual(value)
  expect(intersect([binary, { kind: "number" }])).toStrictEqual({ kind: "never" })
  expect(intersect([binary, { kind: "literal", value: null }])).toStrictEqual({ kind: "never" })
})

it("keeps nested diagnostic calculations independent of their caller's reference budget", () => {
  const implied: Type = {
    kind: "object",
    inferred: true,
    fields: [{ name: "x", type: UNKNOWN, required: true }],
  }
  const mixed: Declaration = {
    name: "Mixed",
    complete: true,
    type: union([
      { kind: "string" },
      { kind: "object", fields: [{ name: "x", type: { kind: "number" }, required: false }] },
    ]),
  }
  const reference: Type = { kind: "ref", target: mixed }
  const outer: Declaration = {
    name: "Outer",
    complete: true,
    type: union([
      { kind: "string" },
      {
        kind: "object",
        fields: [
          {
            name: "p",
            required: false,
            type: { kind: "intersection", members: [implied, reference] },
          },
        ],
      },
    ]),
  }
  const expected = intersect([implied, reference])
  const observations: Type[] = []
  intersect(
    [
      { kind: "object", inferred: true, fields: [{ name: "p", required: true, type: UNKNOWN }] },
      { kind: "ref", target: outer },
    ],
    {
      onWiden: () => {
        observations.push(intersect([implied, reference]))
      },
    },
  )
  expect(observations).toHaveLength(1)
  expect(observations[0]).toStrictEqual(expected)
  expect(expected).toStrictEqual(
    union([
      { kind: "string" },
      {
        kind: "object",
        fields: [
          {
            name: "x",
            type: { kind: "number" },
            required: true,
            direction: undefined,
            requiredOnly: undefined,
          },
        ],
      },
    ]),
  )
})

it("keeps unfinished references opaque and declaration identities local to each calculation", () => {
  const first: Declaration = { name: "Same", type: { kind: "string" } }
  const second: Declaration = { name: "Same", type: { kind: "string" } }
  const a: Type = { kind: "ref", target: first }
  const b: Type = { kind: "ref", target: second }
  expect(union([a, b, a])).toStrictEqual({ kind: "union", members: [a, b] })
  expect(union([UNKNOWN, a])).toStrictEqual({ kind: "union", members: [UNKNOWN, a] })
  first.complete = true
  expect(union([UNKNOWN, a])).toStrictEqual(UNKNOWN)
  expect(union([UNKNOWN, b])).toStrictEqual({ kind: "union", members: [UNKNOWN, b] })
})
