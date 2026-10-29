import { describe, expect, it } from "vitest"
import { generate } from "../../src/core/index"
import { contentTypeErrors } from "../support/content"
import {
  codes,
  declaration,
  documentSource,
  entry,
  gen,
  oas,
  withSchemas,
} from "../support/generate"
import { expectPassesTsc } from "../support/tsc"

const readWriteDoc = (version: "3.0" | "3.1") =>
  oas(version, {
    paths: {
      "/users": {
        post: {
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Team" } } },
          },
          responses: {
            "201": {
              description: "Created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Team" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        User: {
          type: "object",
          required: ["id", "name", "password"],
          properties: {
            id: { type: "string", readOnly: true },
            name: { type: "string" },
            password: { type: "string", writeOnly: true },
          },
        },
        Team: { type: "object", properties: { lead: { $ref: "#/components/schemas/User" } } },
        Unused: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", readOnly: true } },
        },
      },
    },
  })

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

/** A `POST /pets` that sends and returns `schema`. */
const post = (schema: unknown) => ({
  "/pets": {
    post: {
      requestBody: { content: { "application/json": { schema } } },
      responses: { "200": { description: "OK", content: { "application/json": { schema } } } },
    },
  },
})

const binary = { type: "string", format: "binary" }

const directionalPost = (schema: unknown) => ({
  "/test": {
    post: {
      requestBody: { content: { "application/json": { schema } } },
      responses: { "200": { description: "OK", content: { "application/json": { schema } } } },
    },
  },
})

describe("transport and direction projections", () => {
  it("keeps raw media content as Blob while projecting schema binary annotations as strings", async () => {
    const code = await gen(
      oas("3.1", {
        components: { schemas: { Blob: { type: "string" }, Bytes: binary } },
        paths: {
          "/file": {
            post: {
              requestBody: {
                content: {
                  "application/octet-stream": { schema: ref("Bytes") },
                  "application/json": { schema: ref("Bytes") },
                  "multipart/form-data": {
                    schema: { type: "object", properties: { file: ref("Bytes") } },
                  },
                },
              },
              responses: {
                "200": { description: "File", content: { "image/png": { schema: ref("Bytes") } } },
              },
            },
          },
        },
      }),
    )
    expect(entry(code, "POST /file")).toContain('"image/png": Blob')
    expect(declaration(code, "Bytes")).toContain("string")
    await expectPassesTsc(
      code,
      `
import type { Endpoints, Schemas } from "./file0"
export const response: Endpoints["POST /file"]["responses"]["200"]["content"]["image/png"] = new Blob([])
export const request: NonNullable<Endpoints["POST /file"]["body"]>["application/octet-stream"] = new Blob([])
export const json: Schemas.Bytes = "encoded"
// @ts-expect-error Raw media content is not a JSON string projection.
export const invalid: typeof response = "encoded"
`,
    )
  })

  describe("readOnly and writeOnly: `required` applies to one side only", () => {
    it("emits request-side variants where requiredness differs, transitively", async () => {
      const code = await gen(readWriteDoc("3.0"))
      expect(declaration(code, "User")).toBe(
        "{\n  /** @readOnly */\n  id: string\n  name: string\n  /** @writeOnly */\n  password?: string\n}",
      )
      expect(declaration(code, "UserInput")).toBe(
        "{\n  /** @readOnly */\n  id?: string\n  name: string\n  /** @writeOnly */\n  password: string\n}",
      )
      expect(declaration(code, "TeamInput")).toBe("{\n  lead?: UserInput\n}")
      expect(entry(code, "POST /users")).toContain(
        'body: { "application/json": Schemas.TeamInput }',
      )
      expect(entry(code, "POST /users")).toContain(
        '"201": { content: { "application/json": Schemas.Team } }',
      )
      // Variants exist only for schemas a request uses.
      expect(code).not.toContain("UnusedInput")
      await expectPassesTsc(code)
    })

    it("applies them in 3.1+ too, where they are annotations", async () => {
      const result = await generate(readWriteDoc("3.1"))
      expect(declaration(result.code, "UserInput")).toContain("  id?: string")
      expect(entry(result.code, "POST /users")).toContain(
        'body: { "application/json": Schemas.TeamInput }',
      )
      expect(result.diagnostics).toStrictEqual([])
    })
  })

  describe("readOnly and writeOnly across schemas", () => {
    it.each(["readOnly", "writeOnly"] as const)(
      "handles deeply shared references with %s without expanding every path",
      async (flag) => {
        const schemas: Record<string, unknown> = {
          Level0: { type: "object", properties: { id: { type: "string", [flag]: true } } },
        }
        for (let level = 1; level <= 24; level++) {
          const keyword = ["allOf", "anyOf", "oneOf"][level % 3]
          schemas[`Level${level}`] = {
            [keyword]: [ref(`Level${level - 1}`), ref(`Level${level - 1}`)],
          }
        }
        schemas.Pet = { type: "object", required: ["id"], allOf: [ref("Level24")] }
        const code = await gen(oas("3.0", { paths: post(ref("Pet")), components: { schemas } }))
        const optional = flag === "readOnly" ? "Input" : ""
        const required = flag === "readOnly" ? "" : "Input"
        await expectPassesTsc(
          code,
          [
            'import type { Schemas } from "./file0"',
            `const omitted: Schemas.Pet${optional} = {}`,
            `const present: Schemas.Pet${required} = { id: "x" }`,
            "// @ts-expect-error Shared references preserve the opposite side requirement.",
            `const missing: Schemas.Pet${required} = {}`,
          ].join("\n"),
        )
      },
    )

    it.each([
      ["anyOf", "readOnly"],
      ["anyOf", "writeOnly"],
      ["oneOf", "readOnly"],
      ["oneOf", "writeOnly"],
    ] as const)("applies %s branch %s annotations to outer requirements", async (keyword, flag) => {
      const branch = (type: string, annotation = flag) => ({
        properties: { id: { type, [annotation]: true } },
      })
      const alternatives = [branch("string"), branch("number")]
      const base = {
        type: "object",
        required: ["id"],
        properties: {
          nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      }
      const cases = {
        Inline: { ...base, [keyword]: alternatives },
        Wrapped: { ...base, allOf: [{ [keyword]: alternatives.map((b) => ({ allOf: [b] })) }] },
        Other: { ...base, required: ["id", "other"], [keyword]: alternatives },
        Mixed: {
          ...base,
          [keyword]: [alternatives[0], { properties: { id: { type: "number" } } }],
        },
        Missing: { ...base, [keyword]: [alternatives[0], {}] },
        Conflicting: {
          ...base,
          [keyword]: [
            alternatives[0],
            branch("number", flag === "readOnly" ? "writeOnly" : "readOnly"),
          ],
        },
      }
      const code = await gen(
        oas("3.0", {
          paths: Object.fromEntries(
            Object.entries(cases).map(([name, schema]) => [`/${name}`, post(schema)["/pets"]]),
          ),
        }),
      )
      const optional = flag === "readOnly" ? "Request" : "Response"
      const required = flag === "readOnly" ? "Response" : "Request"
      await expectPassesTsc(
        code,
        [
          'import type { Endpoints } from "./file0"',
          ...Object.keys(cases).flatMap((name) => [
            `type ${name}Request = NonNullable<Endpoints["POST /${name}"]["body"]>["application/json"]`,
            `type ${name}Response = Endpoints["POST /${name}"]["responses"][200]["content"]["application/json"]`,
          ]),
          ...["Inline", "Wrapped"].flatMap((name) => [
            `const omitted${name}: ${name}${optional} = {}`,
            `const string${name}: ${name}${required} = { id: "x" }`,
            `const number${name}: ${name}${required} = { id: 1 }`,
            "// @ts-expect-error The opposite side still requires id.",
            `const missing${name}: ${name}${required} = {}`,
            "// @ts-expect-error Parent annotations do not change nested requirements.",
            `const nested${name}: ${name}${optional} = { nested: {} }`,
          ]),
          `const other: Other${optional} = { other: true }`,
          ...["Request", "Response"].flatMap((side) => [
            "// @ts-expect-error Unrelated outer requirements remain required.",
            `const missingOther${side}: Other${side} = { id: "x" }`,
          ]),
          ...["Request", "Response"].flatMap((side) =>
            ["Mixed", "Missing", "Conflicting"].flatMap((name) => {
              const checks = [`const present${name}${side}: ${name}${side} = { id: "x" }`]
              if (side === required && name !== "Conflicting") {
                checks.push(
                  "// @ts-expect-error Unannotated and same-direction branches still require id here.",
                )
              }
              checks.push(`const missing${name}${side}: ${name}${side} = {}`)
              return checks
            }),
          ),
        ].join("\n"),
      )
    })

    it.each(["readOnly", "writeOnly"] as const)(
      "propagates %s requiredness through inline unions on both sides",
      async (flag) => {
        const shapes = {
          type: "object",
          properties: {
            id: { type: "string", [flag]: true },
            nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          },
        }
        const alternatives = { anyOf: [{ required: ["id"] }, { required: ["other"] }] }
        const code = await gen(
          oas("3.0", {
            paths: post({ anyOf: [ref("Nested"), ref("Sibling"), ref("Intersection")] }),
            components: {
              schemas: {
                Nested: { ...shapes, allOf: [alternatives] },
                Sibling: { ...shapes, ...alternatives },
                Intersection: {
                  ...shapes,
                  allOf: [
                    {
                      allOf: [
                        {
                          anyOf: Array.from({ length: 17 }, (_, i) => ({
                            required: ["id", `p${i}`],
                          })),
                        },
                        { anyOf: [{ required: ["a"] }, { required: ["b"] }] },
                      ],
                    },
                  ],
                },
              },
            },
          }),
        )
        const optional = flag === "readOnly" ? "Input" : ""
        const required = flag === "readOnly" ? "" : "Input"
        await expectPassesTsc(
          code,
          [
            'import type { Schemas } from "./file0"',
            ...["Nested", "Sibling"].flatMap((name) => [
              `const omitted${name}: Schemas.${name}${optional} = {}`,
              `const present${name}: Schemas.${name}${required} = { id: "x" }`,
              `const alternate${name}: Schemas.${name}${required} = { other: true }`,
              "// @ts-expect-error The property remains required on its applicable side.",
              `const missing${name}: Schemas.${name}${required} = {}`,
              "// @ts-expect-error A parent annotation does not affect nested property names.",
              `const nested${name}: Schemas.${name}${optional} = { nested: {} }`,
            ]),
            `const intersection: Schemas.Intersection${optional} = { p0: true, a: true }`,
            `const presentIntersection: Schemas.Intersection${required} = { id: "x", p0: true, a: true }`,
            "// @ts-expect-error The intersection keeps its requirement on the applicable side.",
            `const missingIntersection: Schemas.Intersection${required} = { p0: true, a: true }`,
          ].join("\n"),
        )
      },
    )

    it("applies a readOnly from one allOf member to a property another requires", async () => {
      const code = await gen(
        oas("3.0", {
          paths: post(ref("Pet")),
          components: {
            schemas: {
              Base: { type: "object", properties: { id: { type: "integer", readOnly: true } } },
              Pet: { allOf: [ref("Base"), { required: ["id", "name"] }] },
              Tag: {
                type: "object",
                required: ["id"],
                properties: { id: { allOf: [{ type: "integer", readOnly: true }] } },
              },
            },
          },
        }),
      )
      expect(declaration(code, "PetInput")).toContain("id?: unknown")
      expect(entry(code, "POST /pets")).toContain('body?: { "application/json": Schemas.PetInput }')
      expect(declaration(code, "Tag")).toContain("id: number")
    })

    it("reads webhook requests as the API sends them, and their responses as you send them", async () => {
      const code = await gen(
        oas("3.1", {
          webhooks: {
            "pet.created": {
              post: {
                requestBody: { content: { "application/json": { schema: ref("Pet") } } },
                responses: {
                  "200": {
                    description: "OK",
                    content: { "application/json": { schema: ref("Ack") } },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              Pet: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "integer", readOnly: true } },
              },
              Ack: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "integer", readOnly: true } },
              },
            },
          },
        }),
      )
      const webhook = code.slice(code.indexOf("export interface Webhooks"))
      expect(webhook).toContain('body?: { "application/json": Schemas.Pet }')
      expect(webhook).toContain('"200": { content: { "application/json": Schemas.AckInput } }')
      expect(code).not.toContain("PetInput")
    })

    it("reports a request-side name it had to change", async () => {
      const result = await generate(
        oas("3.0", {
          paths: post(ref("User")),
          components: {
            schemas: {
              User: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "integer", readOnly: true } },
              },
              UserInput: { type: "string" },
            },
          },
        }),
      )
      expect(declaration(result.code, "UserInput2")).toContain("id?: number")
      expect(codes(result.diagnostics)).toStrictEqual(["renamed-schema #/components/schemas/User"])
    })

    it("follows $dynamicRef to readOnly properties as it follows $ref", async () => {
      const [dynamic, plain] = await Promise.all(
        ["$dynamicRef", "$ref"].map((keyword) =>
          gen(
            oas("3.1", {
              paths: post(ref("Pet")),
              components: {
                schemas: {
                  Id: { type: "integer", readOnly: true },
                  Base: { type: "object", properties: { tag: { type: "string", readOnly: true } } },
                  Pet: {
                    type: "object",
                    required: ["id", "tag"],
                    properties: { id: { [keyword]: "#/components/schemas/Id" } },
                    allOf: [{ [keyword]: "#/components/schemas/Base" }],
                  },
                },
              },
            }),
          ),
        ),
      )
      expect(declaration(dynamic, "PetInput")).toBe("{ id?: Id; tag?: unknown } & Base")
      expect(dynamic).toBe(plain)
    })
  })

  describe("transport projections", () => {
    it("projects recursive JSON, styled fields and nested multipart values to encodable strings", async () => {
      const { code, diagnostics } = await generate(
        oas("3.1", {
          paths: {
            "/f": {
              post: {
                requestBody: {
                  required: true,
                  content: {
                    "multipart/form-data": {
                      schema: {
                        type: "object",
                        required: ["file", "files", "nested", "matrix", "styled"],
                        properties: {
                          file: binary,
                          files: { type: "array", items: binary },
                          nested: { $ref: "#/components/schemas/Node" },
                          matrix: { type: "array", items: { type: "array", items: binary } },
                          styled: binary,
                        },
                      },
                      encoding: { styled: { style: "form" } },
                    },
                  },
                },
                responses: { "204": { description: "Done" } },
              },
            },
          },
          components: {
            schemas: {
              Node: {
                type: "object",
                properties: { file: binary, next: { $ref: "#/components/schemas/Node" } },
              },
            },
          },
        }),
      )
      expect(diagnostics).toStrictEqual([])
      await expectPassesTsc(
        code,
        `
import type { Endpoints } from "./file0"
import type { EndpointArgs } from "openapi-shape/client"
type Input = EndpointArgs<Endpoints, "POST /f">[0]
export const input: Input = { headers: { "content-type": "multipart/form-data" }, body: {
  file: new Blob([]), files: [new Blob([])], nested: { file: "bytes", next: { file: "more" } }, matrix: [["bytes"]], styled: "bytes"
} }
// @ts-expect-error a nested array part is JSON-encoded, not a file
export const bad: Input = { body: { file: new Blob([]), files: [], nested: {}, matrix: [[new Blob([])]], styled: "bytes" } }
`,
      )
    })
  })

  it("keeps raw bytes from being captured by a schema named Blob", async () => {
    const doc = withSchemas("3.1", {
      Blob: { type: "object" },
      Upload: { type: "object", properties: { data: { $ref: "#/components/schemas/Blob" } } },
      Event: {
        type: "object",
        properties: { file: { contentMediaType: "a/b", type: "string", format: "binary" } },
      },
    })
    const code = await gen({
      ...doc,
      paths: {
        "/upload": {
          post: {
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": { schema: { $ref: "#/components/schemas/Event" } },
              },
            },
            responses: { "204": { description: "Uploaded" } },
          },
        },
      },
    })
    expect(declaration(code, "Upload")).toContain("data?: Blob")
    expect(declaration(code, "Event")).toContain("file?: string")
    expect(declaration(code, "EventMultipart")).toContain("file?: globalThis.Blob")
    await expectPassesTsc(
      code,
      'import type { Schemas } from "./file0"\nexport const e: Schemas.EventMultipart = { file: new Blob() }\n',
    )
  })

  it.each([false, true])(
    "preserves binary string literals through allOf (reversed: %s)",
    async (reverse) => {
      const members = [{ type: "string", format: "binary" }, { const: "abc" }]
      const schema = { allOf: reverse ? members.toReversed() : members }
      const { code } = await generate(
        oas("3.2", {
          paths: {
            "/literal": {
              post: {
                requestBody: { required: true, content: { "application/json": { schema } } },
                responses: { "200": { content: { "application/json": { schema } } } },
              },
            },
          },
        }),
      )
      await expectPassesTsc(
        code,
        `
import { createClient } from "openapi-shape/client"
import { contract } from "./file0"
const api = createClient(contract)
const result = await api.result("POST /literal", { body: "abc", headers: { "content-type": "application/json" } })
if (result.error === undefined) {
  result.data satisfies "abc"
  const value: typeof result.data = "abc"
}
// @ts-expect-error the literal constraint still applies
void api.result("POST /literal", { body: "other", headers: { "content-type": "application/json" } })
`,
      )
    },
  )

  it.each(["3.0", "3.1"] as const)(
    "projects binary annotations in %s by transport",
    async (version) => {
      const bytes = { schema: { type: "string", format: "binary" } }
      expect(await contentTypeErrors("application/json", bytes, "string", version)).toBe("")
      expect(await contentTypeErrors("text/plain", bytes, "string", version)).toBe("")
      expect(await contentTypeErrors("text/*", bytes, "unknown", version)).toBe("")
      expect(await contentTypeErrors("*/*", bytes, "string | Blob", version)).toBe("")
      expect(await contentTypeErrors("image/png", bytes, "Blob", version)).toBe("")
      expect(
        await contentTypeErrors(
          "application/json",
          { schema: { type: "string", contentMediaType: "image/png" } },
          "string",
          version,
        ),
      ).toBe("")
    },
  )

  it("excludes non-object inputs from structured form encoding", async () => {
    const { code } = await generate(
      oas("3.2", {
        paths: {
          "/form": {
            post: {
              requestBody: {
                required: true,
                content: { "application/x-www-form-urlencoded": { schema: { type: "number" } } },
              },
              responses: { "204": {} },
            },
          },
        },
      }),
    )
    await expectPassesTsc(
      code,
      `
import {createClient} from "openapi-shape/client"
import {contract} from "./file0"
const api=createClient(contract)
// @ts-expect-error a form encoder cannot encode a number as fields
void api.fetch("POST /form", { body: 1, headers: { "content-type": "application/x-www-form-urlencoded" } })
void api.fetch("POST /form", { body: "already=encoded", headers: { "content-type": "application/x-www-form-urlencoded" } })
`,
    )
  })
})

describe("directional composition", () => {
  it.each(["readOnly", "writeOnly"] as const)(
    "relaxes referenced requirements at a %s use site",
    async (flag) => {
      const base = {
        type: "object",
        properties: {
          id: { type: "string" },
          nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
        required: ["id"],
      }
      const schemas = {
        Use: { allOf: [ref("Base"), { properties: { id: { [flag]: true } } }] },
        Base: base,
        Inline: { allOf: [base, { properties: { id: { [flag]: true } } }] },
      }
      const result = await generate(
        oas("3.0", {
          paths: directionalPost({ anyOf: [ref("Use"), ref("Inline")] }),
          components: { schemas },
        }),
      )
      expect(result.diagnostics).toStrictEqual([])
      expect(declaration(result.code, "Base")).toContain("id: string")
      const optional = flag === "readOnly" ? "Input" : ""
      const required = flag === "readOnly" ? "" : "Input"
      await expectPassesTsc(
        result.code,
        [
          'import type { Schemas } from "./file0"',
          ...["Use", "Inline"].flatMap((name) => [
            `const absent${name}: Schemas.${name}${optional} = {}`,
            `const present${name}: Schemas.${name}${required} = { id: "ok" }`,
            "// @ts-expect-error The opposite side still requires id.",
            `const missing${name}: Schemas.${name}${required} = {}`,
            "// @ts-expect-error Nested same-name properties retain requiredness.",
            `const nested${name}: Schemas.${name}${optional} = { nested: {} }`,
          ]),
          "// @ts-expect-error Shared declarations are unchanged.",
          "const base: Schemas.Base = {}",
        ].join("\n"),
      )
    },
  )

  it.each(["anyOf", "oneOf"] as const)(
    "keeps %s mixed annotation requirements inside their branches",
    async (keyword) => {
      const schemas = {
        Use: { required: ["id"], [keyword]: [ref("Read"), ref("Plain"), ref("Write")] },
        Read: {
          type: "object",
          properties: { kind: { const: "read" }, id: { type: "string", readOnly: true } },
          required: ["kind"],
        },
        Plain: {
          type: "object",
          properties: { kind: { const: "plain" }, id: { type: "number" } },
          required: ["kind"],
        },
        Write: {
          type: "object",
          properties: { kind: { const: "write" }, id: { type: "boolean", writeOnly: true } },
          required: ["kind"],
        },
      }
      const result = await generate(
        oas("3.0", { paths: directionalPost(ref("Use")), components: { schemas } }),
      )
      expect(result.diagnostics).toStrictEqual([])
      await expectPassesTsc(
        result.code,
        [
          'import type { Schemas } from "./file0"',
          'const read: Schemas.UseInput = { kind: "read" }',
          'const write: Schemas.Use = { kind: "write" }',
          ...["", "Input"].flatMap((side) => [
            `const plain${side}: Schemas.Use${side} = { kind: "plain", id: 1 }`,
            "// @ts-expect-error An unannotated branch still requires id.",
            `const missingPlain${side}: Schemas.Use${side} = { kind: "plain" }`,
          ]),
          "// @ts-expect-error Read-only is still required in responses.",
          'const missingRead: Schemas.Use = { kind: "read" }',
          "// @ts-expect-error Write-only is still required in requests.",
          'const missingWrite: Schemas.UseInput = { kind: "write" }',
        ].join("\n"),
      )
    },
  )

  it.each([63, 64, 65])("bounds directional branch expansion at %i alternatives", async (count) => {
    const choices = Array.from({ length: count }, (_, index) => ({
      type: "object",
      properties: {
        kind: { const: index },
        id: { type: "string", ...(index % 2 === 0 ? { readOnly: true } : {}) },
      },
      required: ["kind"],
    }))
    const result = await generate(
      oas("3.1", {
        paths: directionalPost(ref("Use")),
        components: { schemas: { Use: { required: ["id"], anyOf: choices } } },
      }),
    )
    expect(result.diagnostics.map((d) => d.code)).toStrictEqual(
      count > 64 ? ["schema-precision-loss"] : [],
    )
    const message = expect.stringContaining("64 branch scopes")
    expect(result.diagnostics).toMatchObject(
      count > 64
        ? [
            {
              location: "#/components/schemas/Use",
              message,
            },
          ]
        : [],
    )
    await expectPassesTsc(
      result.code,
      [
        'import type { Schemas } from "./file0"',
        "const read: Schemas.UseInput = { kind: 0 }",
        'const plain: Schemas.UseInput = { kind: 1, id: "ok" }',
        "// @ts-expect-error Responses retain their requirement even when requests widen.",
        "const response: Schemas.Use = { kind: 0 }",
        count <= 64
          ? "// @ts-expect-error Plain branches retain their requirement within budget."
          : "// Beyond the budget this requirement is deliberately relaxed.",
        "const missing: Schemas.UseInput = { kind: 1 }",
        "// @ts-expect-error Widening retains unrelated branch constraints.",
        'const wrong: Schemas.UseInput = { kind: "wrong" }',
      ].join("\n"),
    )
  })

  it("preserves directional scopes across declaration order and external aliases", async () => {
    const read = {
      type: "object",
      properties: { kind: { const: "read" }, id: { type: "string", readOnly: true } },
      required: ["kind"],
    }
    const plain = {
      type: "object",
      properties: { kind: { const: "plain" }, id: { type: "number" } },
      required: ["kind"],
    }
    for (const external of [false, true]) {
      for (const reverse of [false, true]) {
        const schemas = {
          Use: { required: ["id"], anyOf: [ref("Alias"), plain] },
          Alias: external ? { $ref: "https://directions.test/read.json" } : ref("Read"),
          Read: read,
          Unknown: { type: "object", required: ["id"], anyOf: [true, ref("Alias")] },
        }
        // oxlint-disable-next-line no-await-in-loop -- keep the variant attached to its compiler result
        const result = await generate(
          ...documentSource(
            oas("3.1", {
              paths: directionalPost({ anyOf: [ref("Use"), ref("Unknown")] }),
              components: {
                schemas: reverse
                  ? Object.fromEntries(Object.entries(schemas).toReversed())
                  : schemas,
              },
            }),
            "https://directions.test/api.json",
            { loader: () => Response.json(read) },
          ),
        )
        expect(result.diagnostics).toStrictEqual([])
        // oxlint-disable-next-line no-await-in-loop -- independent positive and negative witnesses per variant
        await expectPassesTsc(
          result.code,
          [
            'import type { Schemas } from "./file0"',
            'const read: Schemas.UseInput = { kind: "read" }',
            'const unknownRead: Schemas.UnknownInput = { kind: "read" }',
            "const unknownPlain: Schemas.Unknown = { id: 12 }",
            "// @ts-expect-error Plain branches still require id.",
            'const plain: Schemas.UseInput = { kind: "plain" }',
            "// @ts-expect-error Unknown alternatives do not absorb directional annotations.",
            'const response: Schemas.Unknown = { kind: "read" }',
            "// @ts-expect-error Shared declarations are unchanged.",
            'const shared: Schemas.Read = { kind: "plain" }',
          ].join("\n"),
        )
      }
    }
  })

  it.each(["readOnly", "writeOnly"] as const)(
    "retains %s after mixed-shape widening",
    async (flag) => {
      for (const count of [16, 17]) {
        for (const inline of [false, true]) {
          const annotated = {
            properties: { id: { type: "string", [flag]: true } },
            anyOf: [
              ...Array.from({ length: count - 1 }, (_, index) => ({ const: `s${index}` })),
              { type: "object", properties: { kind: { const: "object" } }, required: ["kind"] },
            ],
          }
          // oxlint-disable-next-line no-await-in-loop -- check each widening boundary independently
          const result = await generate(
            oas("3.1", {
              paths: directionalPost(ref("Use")),
              components: {
                schemas: {
                  Use: {
                    type: "object",
                    required: ["id"],
                    allOf: [inline ? annotated : ref("Annotated")],
                  },
                  Annotated: annotated,
                },
              },
            }),
          )
          const optional = flag === "readOnly" ? "Input" : ""
          const required = flag === "readOnly" ? "" : "Input"
          // oxlint-disable-next-line no-await-in-loop -- retain both positive and negative witnesses
          await expectPassesTsc(
            result.code,
            [
              'import type { Schemas } from "./file0"',
              `const valid: Schemas.Use${optional} = { kind: "object" }`,
              "// @ts-expect-error The opposite direction retains requiredness.",
              `const missing: Schemas.Use${required} = { kind: "object" }`,
              "// @ts-expect-error Explicit constraints survive widening.",
              `const wrong: Schemas.Use${optional} = { kind: "wrong" }`,
              'const scalar: Schemas.Annotated = "s0"',
            ].join("\n"),
          )
        }
      }
    },
  )

  it.each(["readOnly", "writeOnly"] as const)(
    "retains %s when large unions widen to objects or unknown",
    async (flag) => {
      for (const mixed of [false, true]) {
        const annotated = { type: "object", properties: { id: { type: "string", [flag]: true } } }
        const alternatives = [
          annotated,
          ...Array.from({ length: 100 }, (_, index) =>
            mixed
              ? { const: `s${index}` }
              : { type: "object", properties: { value: { const: index } } },
          ),
        ]
        // oxlint-disable-next-line no-await-in-loop -- exercise both widening representations
        const result = await generate(
          oas("3.1", {
            paths: directionalPost(ref("Use")),
            components: {
              schemas: {
                Use: { type: "object", required: ["id"], allOf: [ref("Wide")] },
                Wide: {
                  allOf: [
                    { anyOf: alternatives },
                    {
                      anyOf: Array.from({ length: 100 }, (_, index) => ({
                        type: "object",
                        properties: { kind: { const: index } },
                        required: ["kind"],
                      })),
                    },
                  ],
                },
              },
            },
          }),
        )
        expect(result.diagnostics.map((d) => d.code)).toContain("schema-precision-loss")
        const optional = flag === "readOnly" ? "Input" : ""
        const required = flag === "readOnly" ? "" : "Input"
        // oxlint-disable-next-line no-await-in-loop -- retain constraints from the union that was not widened
        await expectPassesTsc(
          result.code,
          [
            'import type { Schemas } from "./file0"',
            `const valid: Schemas.Use${optional} = { kind: 0 }`,
            "// @ts-expect-error Opposite-direction requirements survive widening.",
            `const missing: Schemas.Use${required} = { kind: 0 }`,
            "// @ts-expect-error Unwidened union constraints survive.",
            `const wrong: Schemas.Use${optional} = { kind: 1000 }`,
          ].join("\n"),
        )
      }
    },
  )
})
