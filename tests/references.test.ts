import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { GenerateError, generate } from "../src/core/index"
import { codes, declaration, entry, gen, oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"
import { expectPassesTsc } from "./helpers/tsc"

async function errorsOf(promise: Promise<unknown>): Promise<string[]> {
  const failure: unknown = await promise.catch((error: unknown) => error)
  if (!(failure instanceof GenerateError)) {
    throw new TypeError(`Expected GenerateError, got ${String(failure)}`)
  }
  return codes(failure.diagnostics.filter((d) => d.severity === "error"))
}

/** A schema claiming `https://spec.test/<n>.json`, typed apart from the document there. */
const claims = (n: number) => ({ $id: `https://spec.test/${n}.json`, type: "number" })

/** Serve documents by path on 127.0.0.1 for the duration of `fn`. */
async function serving<T>(
  documents: Record<string, object>,
  fn: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    const path = request.url ?? "/"
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(documents[path] ?? {}))
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

describe("reference resolution", () => {
  describe("references across documents", () => {
    it.each([undefined, "https://schemas.test/value"])(
      "resolves redirected document anchors through retrieval aliases (schema id: %s)",
      async (id) => {
        const calls: string[] = []
        const result = await generate(
          oas("3.1", {
            components: {
              schemas: {
                Alias: { $ref: "alias.json#named" },
                OtherAlias: { $ref: "other.json#named" },
                Final: { $ref: "moved.json#named" },
                Pointer: { $ref: "alias.json#/$defs/Named" },
              },
            },
          }),
          {
            base: "https://spec.test/api.json",
            load: (uri) => {
              calls.push(uri)
              const response = Response.json({
                ...(id === undefined ? {} : { $id: id }),
                $defs: { Named: { $anchor: "named", type: "string" } },
              })
              Object.defineProperty(response, "url", { value: "https://spec.test/moved.json" })
              return response
            },
          },
        )
        expect(result.diagnostics).toStrictEqual([])
        expect(declaration(result.code, "Alias")).toBe("string")
        expect(declaration(result.code, "OtherAlias")).toBe("Alias")
        expect(declaration(result.code, "Final")).toBe("Alias")
        expect(declaration(result.code, "Pointer")).toBe("Alias")
        expect(calls).not.toContain("https://schemas.test/value")
      },
    )

    it("resolves redirected anchors exposed by a later explicit schema reference", async () => {
      const result = await generate(
        oas("3.1", {
          components: {
            schemas: {
              Alias: { $ref: "alias.json#named" },
              Pointer: { $ref: "alias.json#/x-schema" },
            },
          },
        }),
        {
          base: "https://spec.test/api.json",
          load: () => {
            const response = Response.json({ "x-schema": { $anchor: "named", type: "string" } })
            Object.defineProperty(response, "url", { value: "https://spec.test/moved.json" })
            return response
          },
        },
      )
      expect(result.diagnostics).toStrictEqual([])
      expect(declaration(result.code, "Alias")).toBe("string")
      expect(declaration(result.code, "Pointer")).toBe("Alias")
    })

    it("reuses a retrieved entry document when other URLs redirect to it", async () => {
      const uri = "https://spec.test/api.json"
      const document = oas("3.1", {
        components: {
          schemas: {
            Value: { $anchor: "named", type: "string" },
            Alias: { $ref: "alias.json#named" },
            OtherAlias: { $ref: "other.json#named" },
          },
        },
      })
      const result = await generate(uri, {
        load: () => {
          const response = Response.json(document)
          Object.defineProperty(response, "url", { value: uri })
          return response
        },
      })
      expect(result.diagnostics).toStrictEqual([])
      expect(declaration(result.code, "Value")).toBe("string")
      expect(declaration(result.code, "Alias")).toBe("Value")
      expect(declaration(result.code, "OtherAlias")).toBe("Value")
    })

    it("plans repeated inline reference names before their first use", async () => {
      const result = await generate(
        oas("3.1", {
          "components": {
            schemas: {
              Owner: {
                type: "object",
                properties: {
                  first: { $ref: "#/x-definitions/value" },
                  second: { $ref: "#/x-definitions/value" },
                },
              },
            },
          },
          "x-definitions": { value: { type: "object", properties: { id: { type: "string" } } } },
        }),
      )
      expect(result.diagnostics).toStrictEqual([])
      expect(declaration(result.code, "Owner")).toBe(
        "{\n  first?: x_definitions_value\n  second?: x_definitions_value\n}",
      )
      expect(declaration(result.code, "x_definitions_value")).toBe("{\n  id?: string\n}")
    })

    it("discovers references behind an anchor made visible by later dictionary indexing", async () => {
      const calls: string[] = []
      const result = await generate(
        oas("3.1", {
          components: {
            schemas: {
              Anchor: { $ref: "common.json#named" },
              Pointer: { $ref: "common.json#/x-schemas/Value" },
            },
          },
        }),
        {
          base: "https://spec.test/api.json",
          load: (uri) => {
            calls.push(uri)
            if (uri.endsWith("value.json")) return Response.json({ type: "string" })
            return Response.json({
              "x-schemas": {
                Value: { type: "number" },
                Named: { $anchor: "named", properties: { value: { $ref: "value.json" } } },
              },
            })
          },
        },
      )
      expect(result.diagnostics).toStrictEqual([])
      expect(declaration(result.code, "Anchor")).toContain("value?: value")
      expect(declaration(result.code, "value")).toBe("string")
      expect(calls).toStrictEqual(["https://spec.test/common.json", "https://spec.test/value.json"])
    })

    it("loads only schemas selected by semantic positions", async () => {
      const ref = { $ref: "unused.json" }
      const calls: string[] = []
      const result = await generate(
        oas("3.1", {
          components: {
            schemas: {
              Value: { "type": "string", "examples": [ref], "default": ref, "x-schema": ref },
            },
            parameters: { Unused: ref },
          },
          paths: {
            "/value": {
              get: {
                responses: {
                  "200": {
                    content: {
                      "application/octet-stream": { schema: ref },
                      "text/plain": { schema: { type: "object", properties: { hidden: ref } } },
                      "application/json": { schema: { type: "string" }, examples: { unused: ref } },
                    },
                    headers: { "Content-Type": ref },
                  },
                },
              },
            },
          },
        }),
        {
          base: "https://spec.test/api.json",
          load: (uri) => {
            calls.push(uri)
            return Response.json({ type: "number" })
          },
        },
      )
      expect(result.diagnostics).toStrictEqual([])
      expect(calls).toStrictEqual([])
    })

    it.each(["$anchor", "$dynamicAnchor"])(
      "does not let discriminator mapping %s shadow an anchor",
      async (keyword) => {
        const { code, diagnostics } = await generate(
          oas("3.1", {
            components: {
              schemas: {
                Pet: {
                  oneOf: [{ $ref: "#/components/schemas/Target" }],
                  discriminator: { propertyName: "kind", mapping: { [keyword]: "Target" } },
                },
                Target: {
                  [keyword]: "Target",
                  type: "object",
                  properties: { kind: { type: "string" } },
                  required: ["kind"],
                },
                Alias: { $ref: "#Target" },
              },
            },
          }),
        )
        expect(diagnostics).toStrictEqual([])
        expect(declaration(code, "Alias")).toBe("Target")
      },
    )

    it("keeps discriminator mapping names out of the schema resource index", async () => {
      const uri = "https://spec.test/cat.json"
      const calls: string[] = []
      const { code, diagnostics } = await generate(
        oas("3.1", {
          components: {
            schemas: {
              Pet: {
                oneOf: [{ $ref: uri }],
                discriminator: {
                  propertyName: "kind",
                  mapping: { $id: uri, $anchor: "Local", $dynamicAnchor: "Dynamic" },
                },
              },
              Local: { $anchor: "local", type: "string" },
              Dynamic: { $dynamicAnchor: "dynamic", type: "number" },
              LocalUse: { $ref: "#local" },
              DynamicUse: { $ref: "#dynamic" },
              Named: {
                type: "object",
                properties: { discriminator: { $id: "https://spec.test/named", type: "boolean" } },
              },
              NamedUse: { $ref: "https://spec.test/named" },
            },
          },
        }),
        {
          base: "https://spec.test/api.json",
          load: (url) => {
            calls.push(url)
            return Response.json({
              type: "object",
              properties: { kind: { type: "string" }, name: { type: "string" } },
              required: ["kind", "name"],
            })
          },
        },
      )
      expect(calls).toStrictEqual([uri])
      expect(diagnostics).toStrictEqual([])
      expect(declaration(code, "cat")).toContain("name: string")
      expect(declaration(code, "LocalUse")).toBe("Local")
      expect(declaration(code, "DynamicUse")).toBe("Dynamic")
      expect(declaration(code, "NamedUse")).toBe("boolean")
    })

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
          "api/parameters.yaml":
            "limit:\n  name: limit\n  in: query\n  schema: { type: integer }\n",
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
          const operation = entry(code, "GET /pets")
          expect(operation).toContain("query?: { limit?: number }")
          expect(operation).toContain('"200": { content: { "application/json": Schemas.Pet[] } }')
          expect(operation).toContain(
            '"default": { content: { "application/json": Schemas.Error } }',
          )
          await expectPassesTsc(code)
        },
      )
    })

    it("resolves an in-memory document's relative references against `base`", async () => {
      await withFiles({ "schemas/thing.json": { type: "string" } }, async (dir) => {
        const doc = oas("3.1", {
          components: { schemas: { Thing: { $ref: "schemas/thing.json" } } },
        })
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
        expect(declaration(await gen(doc, { base: join(dir, "root.json") }), "Thing")).toBe(
          "boolean",
        )
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

    it("ignores $id and anchors in extensions, instance data, and links", async () => {
      const calls: string[] = []
      const api = "https://spec.test/api.json"
      const doc = oas("3.1", {
        "x-metadata": claims(0),
        "paths": {
          "x-internal": { schema: claims(1) },
          "/pets": {
            get: {
              responses: {
                "200": { description: "OK", links: { self: { requestBody: claims(2) } } },
                "x-ext": { content: { "application/json": { schema: claims(3) } } },
              },
            },
          },
        },
        "x-defs": {
          Pet: {
            $id: "https://other.test/pet.json",
            type: "object",
            properties: { tag: { $ref: "#/components/schemas/Tag" } },
          },
        },
        "components": {
          schemas: {
            ...Object.fromEntries(
              [0, 1, 2, 3, 4].map((n) => [`S${n}`, { $ref: `https://spec.test/${n}.json` }]),
            ),
            Holder: { "type": "object", "x-shape": claims(4), "default": { $anchor: "held" } },
            // References inside an extension resolve against the document.
            Pet: { $ref: "#/x-defs/Pet" },
            Tag: { type: "integer" },
          },
        },
      })
      const result = await generate(api, {
        load: (url) => {
          calls.push(url)
          return Response.json(url === api ? doc : { type: "string" })
        },
      })
      expect(calls).toStrictEqual([
        api,
        ...[0, 1, 2, 3, 4].map((n) => `https://spec.test/${n}.json`),
      ])
      for (const n of [0, 1, 2, 3, 4]) expect(declaration(result.code, `S${n}`)).toBe("string")
      expect(declaration(result.code, "Pet")).toBe("{\n  tag?: Tag\n}")
    })

    it("moves a document's base only by its own $ids", async () => {
      const api = "https://spec.test/api.json"
      const nested = { $id: "lib/", $ref: "#/$defs/S", $defs: { S: { type: "null" } } }
      const result = await generate(
        oas("3.1", {
          paths: { "/a": { get: { responses: { "200": { $ref: "alias.json#/R" } } } } },
          components: {
            schemas: {
              Pet: {
                type: "object",
                properties: { t: { $ref: "defs.json#/$defs/T" } },
                $defs: { "a~b": { type: "object", properties: { p: nested } } },
              },
              // A pointer `parsePointer` reads leniently, as the key "a~b".
              Lib: { $ref: "#/components/schemas/Pet/$defs/a~b" },
            },
          },
        }),
        {
          base: api,
          load: (url) => {
            if (url !== "https://spec.test/alias.json") {
              const type = url.startsWith("https://evil.test/") ? "boolean" : "string"
              return Response.json({ $defs: { T: { type } } })
            }
            // Another document at the entry's address, as a redirect leaves it.
            const response = Response.json({
              R: { description: "OK" },
              components: { schemas: { Pet: { $id: "https://evil.test/pet.json" } } },
            })
            Object.defineProperty(response, "url", { value: api })
            return response
          },
        },
      )
      expect(declaration(result.code, "T")).toBe("string")
      expect(declaration(result.code, "Lib")).toBe("{\n  p?: S\n}")
      expect(declaration(result.code, "S")).toBe("null")
    })

    it("lets an OpenAPI root's $id claim its URI", async () => {
      const code = await gen(
        oas("3.1", {
          $id: "https://root.test/api",
          components: {
            schemas: {
              A: { $ref: "https://root.test/api#/components/schemas/B" },
              C: { $ref: "https://root.test/api#bee" },
              B: { $anchor: "bee", type: "string" },
            },
          },
        }),
      )
      expect([declaration(code, "A"), declaration(code, "C")]).toStrictEqual(["B", "B"])
    })

    it("indexes the schemas of documents without an openapi field", async () => {
      const api = "https://spec.test/api.json"
      const documents: Record<string, object> = {
        [api]: oas("3.1", {
          paths: { "/pets": { $ref: "paths/pets.json" } },
          components: {
            schemas: { Pet: { $ref: "common.json#/Pet" } },
          },
        }),
        // A Path Item file, and a file that lists schemas at its top level.
        "https://spec.test/paths/pets.json": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { n: { $ref: "#count" } },
                      $defs: { N: { $anchor: "count", type: "integer" } },
                    },
                  },
                },
              },
            },
          },
        },
        "https://spec.test/common.json": {
          Pet: {
            $id: "https://other.test/pet",
            type: "object",
            properties: { tag: { $ref: "#/$defs/Tag" } },
            $defs: { Tag: { type: "integer" } },
          },
        },
      }
      const calls: string[] = []
      const result = await generate(api, {
        load: (url) => {
          calls.push(url)
          return Response.json(documents[url])
        },
      })
      expect(calls).not.toContain("https://other.test/pet")
      expect(declaration(result.code, "Pet")).toBe("{\n  tag?: Tag\n}")
      expect(entry(result.code, "GET /pets")).toContain("n?: Schemas.N")
      expect(result.diagnostics).toStrictEqual([])
    })

    it.each([
      "x-User",
      "links",
      "default",
      "discriminator",
      "x-/~用户",
      "properties",
      "schemas",
      "content",
    ])("indexes an explicitly referenced external schema named %s", async (name) => {
      const pointer = name.replaceAll("~", "~0").replaceAll("/", "~1")
      const api = "https://spec.test/api.json"
      const calls: string[] = []
      const documents: Record<string, object> = {
        "https://spec.test/common.json": {
          [name]: {
            "$id": "nested/user.json",
            "type": "object",
            "properties": { id: { $ref: "id.json" }, tag: { $ref: "#tag" } },
            "$defs": { Tag: { $anchor: "tag", type: "boolean" } },
            // Promoting the entry must not promote its metadata as well.
            "x-data": { $id: "id.json", type: "number" },
            "default": { $id: "id.json", type: "number" },
          },
        },
        "https://spec.test/nested/id.json": { type: "string" },
        "https://spec.test/id.json": { type: "null" },
      }
      const result = await generate(
        oas("3.1", { components: { schemas: { User: { $ref: `common.json#/${pointer}` } } } }),
        {
          base: api,
          load: (uri) => {
            calls.push(uri)
            return Response.json(documents[uri])
          },
        },
      )
      expect(result.diagnostics).toStrictEqual([])
      expect(declaration(result.code, "User")).toBe("{\n  id?: id\n  tag?: Tag\n}")
      expect(declaration(result.code, "id")).toBe("string")
      expect(declaration(result.code, "Tag")).toBe("boolean")
      expect(calls).toStrictEqual([
        "https://spec.test/common.json",
        "https://spec.test/nested/id.json",
      ])
    })

    it.each([false, true])(
      "retries anchors after indexing external schema targets (reverse: %s)",
      async (reverse) => {
        const schemas = {
          Anchor: { $ref: "common.json#named" },
          Pointer: { $ref: "common.json#/x-schemas/links/$defs/Value" },
        }
        const calls: string[] = []
        const result = await generate(
          oas("3.1", {
            components: {
              schemas: reverse ? Object.fromEntries(Object.entries(schemas).toReversed()) : schemas,
            },
          }),
          {
            base: "https://spec.test/api.json",
            load: (uri) => {
              calls.push(uri)
              if (uri.endsWith("value.json")) return Response.json({ type: "string" })
              return Response.json({
                "x-schemas": {
                  links: {
                    $anchor: "named",
                    $id: "nested/user.json",
                    $defs: { Value: { $ref: "value.json" } },
                    type: "boolean",
                  },
                  // Its anchor belongs to the containing document, before the nested $id.
                  Named: { $anchor: "named", type: "integer" },
                },
              })
            },
          },
        )
        expect(result.diagnostics).toStrictEqual([])
        expect(declaration(result.code, "Anchor")).toBe("number")
        expect(declaration(result.code, "Pointer")).toBe("string")
        expect(calls).toStrictEqual([
          "https://spec.test/common.json",
          "https://spec.test/nested/value.json",
        ])
      },
    )

    it("keeps an existing resource's anchors when an external schema claims the same URI", async () => {
      const doc = oas("3.1", {
        components: {
          schemas: {
            Owner: { $id: "https://shared.test/schema", $anchor: "owner", type: "string" },
            External: { $ref: "common.json#/x-User" },
            Stolen: { $ref: "https://shared.test/schema#other" },
          },
        },
      })
      expect(
        await errorsOf(
          generate(doc, {
            base: "https://spec.test/api.json",
            load: () =>
              Response.json({
                "x-User": { $id: "https://shared.test/schema", $anchor: "other", type: "number" },
              }),
          }),
        ),
      ).toStrictEqual(["unresolved-ref #/components/schemas/Stolen/$ref"])
    })

    it("indexes nested resources against a schema-valued dictionary entry before claiming URIs", async () => {
      const calls: string[] = []
      const documents: Record<string, object> = {
        "https://spec.test/dict.json": {
          schemas: {
            $id: "sub/parent.json",
            $ref: "#/$defs/Child",
            $defs: { Child: { $id: "child.json", $anchor: "named", type: "string" } },
          },
        },
        "https://spec.test/child.json": { $anchor: "named", type: "number" },
      }
      const result = await generate(
        oas("3.1", {
          components: {
            schemas: {
              Nested: { $ref: "dict.json#/schemas" },
              Separate: { $ref: "child.json#named" },
            },
          },
        }),
        {
          base: "https://spec.test/api.json",
          load: (uri) => {
            calls.push(uri)
            return Response.json(documents[uri])
          },
        },
      )
      expect(result.diagnostics).toStrictEqual([])
      expect(declaration(result.code, "Nested")).toBe("string")
      expect(declaration(result.code, "Separate")).toBe("number")
      expect(calls).toStrictEqual(["https://spec.test/dict.json", "https://spec.test/child.json"])
    })

    it.each(["$anchor", "$dynamicAnchor"])(
      "indexes %s on a schema named like a name map without mistaking map keys for declarations",
      async (keyword) => {
        const result = await generate(
          oas("3.1", {
            components: {
              schemas: { Named: { $ref: "dict.json#named" }, Map: { $ref: "dict.json#/Map" } },
            },
          }),
          {
            base: "https://spec.test/api.json",
            load: () =>
              Response.json({
                properties: { [keyword]: "named", type: "number" },
                Map: {
                  type: "object",
                  properties: { $id: { type: "string" }, $anchor: { type: "boolean" } },
                },
              }),
          },
        )
        expect(result.diagnostics).toStrictEqual([])
        expect(declaration(result.code, "Named")).toBe("number")
        expect(declaration(result.code, "Map")).toBe("{\n  $id?: string\n  $anchor?: boolean\n}")
      },
    )

    it("does not borrow canonical anchors through a redirected document's losing root id", async () => {
      const result = generate(
        oas("3.1", {
          components: {
            schemas: {
              Owner: { $id: "https://shared.test/value", $anchor: "named", type: "string" },
              Other: { $ref: "alias.json#named" },
            },
          },
        }),
        {
          base: "https://spec.test/api.json",
          load: () => {
            const response = Response.json({ $id: "https://shared.test/value", type: "number" })
            Object.defineProperty(response, "url", { value: "https://spec.test/moved.json" })
            return response
          },
        },
      )
      expect(await errorsOf(result)).toStrictEqual([
        "unresolved-ref #/components/schemas/Other/$ref",
      ])
    })

    it("does not activate $id in a 3.0 external schema dictionary", async () => {
      const calls: string[] = []
      const code = await gen(
        oas("3.0", { components: { schemas: { User: { $ref: "common.json#/x-User" } } } }),
        {
          base: "https://spec.test/api.json",
          load: (uri) => {
            calls.push(uri)
            return Response.json(
              uri.endsWith("common.json")
                ? { "x-User": { $id: "nested/user.json", $ref: "value.json" } }
                : { type: "string" },
            )
          },
        },
      )
      expect(declaration(code, "User")).toBe("string")
      expect(calls).toStrictEqual(["https://spec.test/common.json", "https://spec.test/value.json"])
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
        {
          "openapi.json": oas("3.1", { components: { schemas: { A: { $ref: "missing.json" } } } }),
        },
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
})

describe("reference discovery", () => {
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

  it("keeps a URI's anchors with the document that keeps the URI", async () => {
    const api = "https://spec.test/api.json"
    const documents: Record<string, object> = {
      [api]: oas("3.1", {
        components: {
          schemas: {
            A: { $ref: "a.json" },
            B: { $ref: "b.json" },
            Good: { $ref: "https://shared.test/s#good" },
            Evil: { $ref: "https://shared.test/s#evil" },
          },
        },
      }),
      "https://spec.test/a.json": {
        $id: "https://shared.test/s",
        type: "string",
        $defs: { g: { $anchor: "good", const: "g" } },
      },
      "https://spec.test/b.json": { $id: "https://shared.test/s", $anchor: "evil", type: "number" },
    }
    const options = { load: (url: string) => Response.json(documents[url]) }
    expect(await errorsOf(generate(api, options))).toStrictEqual([
      "unresolved-ref #/components/schemas/Evil/$ref",
    ])
    delete (documents[api] as { components: { schemas: { Evil?: unknown } } }).components.schemas
      .Evil
    const { code } = await generate(api, options)
    expect(declaration(code, "Good")).toBe('"g"')
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
