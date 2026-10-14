import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { GenerateError, generate } from "../src/index"
import { codes, declaration, entry, gen, oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"
import { expectPassesTsc } from "./helpers/tsc"

/** Serve documents by path on 127.0.0.1 for the duration of `fn`; `delay` holds back some responses. */
async function serving<T>(
  documents: Record<string, object>,
  fn: (origin: string) => Promise<T>,
  delay: Record<string, number> = {},
): Promise<T> {
  const server = createServer((request, response) => {
    const path = request.url ?? "/"
    setTimeout(() => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(documents[path] ?? {}))
    }, delay[path] ?? 0)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const { port } = server.address() as AddressInfo
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

async function errorsOf(promise: Promise<unknown>): Promise<string[]> {
  const failure: unknown = await promise.catch((error: unknown) => error)
  if (!(failure instanceof GenerateError)) {
    throw new Error(`Expected GenerateError, got ${String(failure)}`)
  }
  return codes(failure.diagnostics.filter((d) => d.severity === "error"))
}

describe("references across documents", () => {
  it("loads relative files, naming their definitions", async () => {
    await withFiles(
      {
        "api/openapi.yaml": [
          "openapi: 3.1.0",
          "info: { title: Split, version: '1' }",
          "paths:",
          "  /pets:",
          "    $ref: ./paths/pets.yaml",
          "components:",
          "  schemas:",
          "    Pet:",
          "      $ref: ../schemas/pet.json",
        ].join("\n"),
        "api/paths/pets.yaml": [
          "get:",
          "  parameters:",
          "    - $ref: '../parameters.yaml#/limit'",
          "  responses:",
          "    '200':",
          "      description: OK",
          "      content:",
          "        application/json:",
          "          schema:",
          "            type: array",
          "            items: { $ref: '../../schemas/pet.json' }",
          "    default:",
          "      $ref: '../../schemas/common.yaml#/components/responses/Error'",
        ].join("\n"),
        "api/parameters.yaml": "limit:\n  name: limit\n  in: query\n  schema: { type: integer }\n",
        "schemas/pet.json": {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "integer" },
            owner: { $ref: "common.yaml#/components/schemas/Owner" },
          },
        },
        "schemas/common.yaml": [
          "openapi: 3.1.0",
          "info: { title: Common, version: '1' }",
          "components:",
          "  schemas:",
          "    Owner: { type: object, properties: { name: { type: string } } }",
          "    Error: { type: object, properties: { message: { type: string } } }",
          "  responses:",
          "    Error:",
          "      description: Failure",
          "      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }",
        ].join("\n"),
      },
      async (dir) => {
        const { code, diagnostics } = await generate(join(dir, "api/openapi.yaml"))
        expect(diagnostics).toStrictEqual([])
        // The component that references the file lends the file its name.
        expect(declaration(code, "Pet")).toBe("{\n  id: number\n  owner?: Owner\n}")
        expect(declaration(code, "Owner")).toBe("{\n  name?: string\n}")
        expect(entry(code, "GET /pets")).toBe(
          [
            "{",
            "  query: { limit?: number }",
            "  response: {",
            "    /** OK */",
            '    "200": Schemas.Pet[]',
            "    /** Failure */",
            '    "default": Schemas.Error',
            "  }",
            "}",
          ].join("\n"),
        )
        await expectPassesTsc(code)
      },
    )
  })

  it("resolves an in-memory document's relative references against `base`", async () => {
    await withFiles({ "schemas/thing.json": { type: "string" } }, async (dir) => {
      const doc = oas("3.1", { components: { schemas: { Thing: { $ref: "schemas/thing.json" } } } })
      expect(declaration(await gen(doc, { base: join(dir, "openapi.json") }), "Thing")).toBe(
        "string",
      )
      expect(await errorsOf(generate(doc))).toStrictEqual([
        "unresolved-ref #/components/schemas/Thing/$ref",
      ])
    })
  })

  it("uses $self (3.2) as the document's base URI", async () => {
    await withFiles({ "shared/thing.json": { type: "boolean" } }, async (dir) => {
      const doc = oas("3.2", {
        $self: "shared/openapi.json",
        components: { schemas: { Thing: { $ref: "thing.json" } } },
      })
      expect(declaration(await gen(doc, { base: join(dir, "root.json") }), "Thing")).toBe("boolean")
    })
  })

  it("reads 3.0 semantics in a 3.0 document referenced from a 3.1 one", async () => {
    await withFiles(
      {
        "old.json": oas("3.0", {
          components: { schemas: { N: { type: "string", nullable: true } } },
        }),
      },
      async (dir) => {
        const doc = oas("3.1", {
          components: { schemas: { M: { $ref: "old.json#/components/schemas/N" } } },
        })
        expect(declaration(await gen(doc, { base: join(dir, "x.json") }), "M")).toBe(
          "string | null",
        )
      },
    )
  })
})

describe("reference errors", () => {
  it("fails on missing targets, collecting every error", async () => {
    const doc = oas("3.1", {
      paths: {
        "/r": { get: { parameters: [{ $ref: "#/components/parameters/Nope" }], responses: {} } },
      },
      components: {
        schemas: { A: { $ref: "#/components/schemas/Missing" }, B: { $ref: "#/nowhere" } },
      },
    })
    expect(await errorsOf(generate(doc))).toStrictEqual([
      "unresolved-ref #/components/schemas/A/$ref",
      "unresolved-ref #/components/schemas/B/$ref",
      "unresolved-ref #/paths/~1r/get/parameters/0/$ref",
    ])
  })

  it("fails on reference cycles between non-schema objects", async () => {
    const doc = oas("3.1", {
      paths: {
        "/r": { get: { parameters: [{ $ref: "#/components/parameters/A" }], responses: {} } },
      },
      components: {
        parameters: {
          A: { $ref: "#/components/parameters/B" },
          B: { $ref: "#/components/parameters/A" },
        },
      },
    })
    expect(await errorsOf(generate(doc))).toStrictEqual([
      "circular-ref #/paths/~1r/get/parameters/0/$ref",
    ])
  })

  it("fails on unreadable documents", async () => {
    await withFiles(
      { "openapi.json": oas("3.1", { components: { schemas: { A: { $ref: "missing.json" } } } }) },
      async (dir) => {
        expect(await errorsOf(generate(join(dir, "openapi.json")))).toStrictEqual([
          "unresolved-ref #/components/schemas/A/$ref",
        ])
      },
    )
  })

  it("does not let remote documents read local files", async () => {
    const server = createServer((_, response) => {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify(
          oas("3.1", { components: { schemas: { A: { $ref: "file:///etc/hosts" } } } }),
        ),
      )
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const { port } = server.address() as AddressInfo
      expect(await errorsOf(generate(`http://127.0.0.1:${port}/openapi.json`))).toStrictEqual([
        "unresolved-ref #/components/schemas/A/$ref",
      ])
    } finally {
      server.close()
    }
  })

  it("schema references may form cycles through properties", async () => {
    const code = await gen(
      oas("3.1", {
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: {
                next: { $ref: "#/components/schemas/Node" },
                all: { type: "array", items: { $ref: "#/components/schemas/Node" } },
              },
            },
          },
        },
      }),
    )
    expect(declaration(code, "Node")).toBe("{\n  next?: Node\n  all?: Node[]\n}")
  })
})

describe("what a document may reach", () => {
  it("keeps an in-memory document without base from reaching files or the network", async () => {
    await withFiles({ "secret.json": { type: "string", const: "TOP-SECRET" } }, async (dir) => {
      const file = pathToFileURL(join(dir, "secret.json")).href
      const docs = [
        oas("3.1", { components: { schemas: { A: { $ref: file } } } }),
        oas("3.2", {
          $self: `${pathToFileURL(dir).href}/`,
          components: { schemas: { A: { $ref: "secret.json" } } },
        }),
        oas("3.1", {
          components: {
            schemas: {
              A: {
                $id: `${pathToFileURL(dir).href}/other.json`,
                properties: { s: { $ref: "secret.json" } },
              },
            },
          },
        }),
        oas("3.1", { components: { schemas: { A: { $ref: "http://127.0.0.1:9/x.json" } } } }),
      ]
      for (const doc of docs) {
        // oxlint-disable-next-line no-await-in-loop -- each case is independent and quick
        const failure: unknown = await generate(doc).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(GenerateError)
        expect(String((failure as GenerateError).message)).toContain("pass the `base` option")
      }
    })
  })

  it("does not let a remote document's $self claim a local file", async () => {
    await withFiles({ "local.json": { type: "integer" } }, async (dir) => {
      const server = createServer((_, response) => {
        response.setHeader("content-type", "application/json")
        response.end(
          JSON.stringify(
            oas("3.2", {
              $self: pathToFileURL(join(dir, "local.json")).href,
              components: { schemas: { Evil: { type: "string" } } },
            }),
          ),
        )
      })
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve)
      })
      try {
        const { port } = server.address() as AddressInfo
        const doc = oas("3.1", {
          components: {
            schemas: {
              Remote: { $ref: `http://127.0.0.1:${port}/openapi.json#/components/schemas/Evil` },
              Local: { $ref: "local.json" },
            },
          },
        })
        const code = await gen(doc, { base: join(dir, "openapi.json") })
        expect(declaration(code, "Local")).toBe("number")
      } finally {
        server.close()
      }
    })
  })

  it("does not let a remote document claim or read a local file through $id", async () => {
    await withFiles(
      { "b.json": { type: "integer" }, "secret.json": { private: { const: "SECRET" } } },
      async (dir) => {
        const local = pathToFileURL(join(dir, "b.json")).href
        const secret = pathToFileURL(join(dir, "secret.json")).href
        await serving(
          {
            "/claim.json": { $defs: { x: { $id: local, const: "REMOTE" } } },
            "/read.json": { $defs: { leak: { $ref: `${secret}#/private` } } },
          },
          async (origin) => {
            const claim = oas("3.1", {
              components: {
                schemas: {
                  Remote: { $ref: `${origin}/claim.json#/$defs/x` },
                  Local: { $ref: "b.json" },
                },
              },
            })
            expect(declaration(await gen(claim, { base: join(dir, "x.json") }), "Local")).toBe(
              "number",
            )
            // The local file is loaded, and still out of the remote document's reach.
            const read = oas("3.1", {
              components: {
                schemas: {
                  Secret: { $ref: "secret.json" },
                  Leak: { $ref: `${origin}/read.json#/$defs/leak` },
                },
              },
            })
            expect(await errorsOf(generate(read, { base: join(dir, "x.json") }))).toStrictEqual([
              `unresolved-ref ${origin}/read.json#/$defs/leak/$ref`,
            ])
          },
        )
      },
    )
  })

  it("does not let a remote document reach a local one through a URI the local one claims", async () => {
    await withFiles(
      { "secret.json": { $id: "urn:local:secret", const: "SECRET" } },
      async (dir) => {
        await serving(
          { "/r.json": { $defs: { leak: { $ref: "urn:local:secret" } } } },
          async (origin) => {
            const doc = oas("3.1", {
              components: {
                schemas: {
                  Secret: { $ref: "secret.json" },
                  Leak: { $ref: `${origin}/r.json#/$defs/leak` },
                },
              },
            })
            expect(await errorsOf(generate(doc, { base: join(dir, "x.json") }))).toStrictEqual([
              `unresolved-ref ${origin}/r.json#/$defs/leak/$ref`,
            ])
          },
        )
      },
    )
  })

  it("lets a remote document reach a local one by the address it publishes as $self", async () => {
    await withFiles({}, async (dir) => {
      const pet = {
        type: "object",
        properties: { owner: { $ref: "openapi.json#/components/schemas/Owner" } },
      }
      await serving({ "/api/pet.json": pet }, async (origin) => {
        const doc = oas("3.2", {
          $self: `${origin}/api/openapi.json`,
          components: {
            schemas: {
              Pet: { $ref: "pet.json" },
              Owner: { type: "object", properties: { name: { type: "string" } } },
            },
          },
        })
        const code = await gen(doc, { base: join(dir, "openapi.json") })
        expect(declaration(code, "Pet")).toBe("{\n  owner?: Owner\n}")
      })
    })
  })

  it("reports a source that is not a valid URL", async () => {
    expect(await errorsOf(generate("http://[bad"))).toStrictEqual(["read-failed #"])
    expect(
      await errorsOf(
        generate(oas("3.1", { components: { schemas: { A: { $ref: "x.json" } } } }), {
          base: "http://[bad",
        }),
      ),
    ).toStrictEqual(["unresolved-ref #/components/schemas/A/$ref"])
  })

  it("resolves a URI two documents claim the same way, whichever loads first", async () => {
    const documents = {
      "/a.json": { $defs: { s: { $id: "https://shared.test/s.json", const: "A" } } },
      "/b.json": { $defs: { s: { $id: "https://shared.test/s.json", const: "B" } } },
    }
    const results = await Promise.all(
      ([{ "/a.json": 50 }, { "/b.json": 50 }] as Array<Record<string, number>>).map((delay) =>
        serving(
          documents,
          async (origin) =>
            declaration(
              await gen(
                oas("3.1", {
                  components: {
                    schemas: {
                      A: { $ref: `${origin}/a.json#/$defs/s` },
                      B: { $ref: `${origin}/b.json#/$defs/s` },
                      Shared: { $ref: "https://shared.test/s.json" },
                    },
                  },
                }),
                { base: `${origin}/openapi.json` },
              ),
              "Shared",
            ),
          delay,
        ),
      ),
    )
    expect(results[0]).toBe(results[1])
  })

  it("reads sources and schema files however their names are written", async () => {
    await withFiles(
      {
        "api/openapi.yaml": [
          "openapi: 3.1.0",
          "info: { title: t, version: '1' }",
          "x-common: &common { type: string }",
          "components:",
          "  schemas:",
          "    Merged: { <<: *common, maxLength: 3 }",
          "    A: { properties: { b: { $ref: 'https://example.com/a%zz.json' } } }",
          "    B: { properties: { c: { $id: 'https://example.com/a%zz.json', type: boolean } } }",
        ].join("\n"),
      },
      async (dir) => {
        // Dot segments and an uppercase scheme name the same document once.
        const source = `FILE://${join(dir, "api/../api/openapi.yaml")}`
        const { code, diagnostics } = await generate(source)
        expect(diagnostics).toStrictEqual([])
        expect(declaration(code, "Merged")).toBe("string")
        // A malformed escape in an $id names the schema as written.
        expect(declaration(code, "a_zz")).toBe("boolean")
      },
    )
  })

  it("rejects documents that refer to themselves or nest too deeply, cleanly", async () => {
    await withFiles(
      { "loop.yaml": "openapi: 3.1.0\ninfo: { title: t, version: '1' }\nx-loop: &a { b: *a }\n" },
      async (dir) => {
        await expect(generate(join(dir, "loop.yaml"))).rejects.toThrow("refers to itself")
      },
    )
    const cyclic: Record<string, unknown> = oas("3.1")
    cyclic.self = cyclic
    await expect(generate(cyclic)).rejects.toThrow(GenerateError)
    let deep: unknown = { type: "string" }
    for (let i = 0; i < 5000; i++) deep = { type: "array", items: deep }
    await expect(generate(oas("3.1", { components: { schemas: { Deep: deep } } }))).rejects.toThrow(
      "nests too deeply",
    )
  })
})
