import { describe, expect, it } from "vitest"
import { generate } from "../src/index"
import { declaration, oas, withSchemas } from "./helpers/generate"

const binary = { type: "string", format: "binary" }
const object = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  properties,
})
const alternatives = (property: string, count: number): Record<string, unknown> => ({
  anyOf: Array.from({ length: count }, (_, value) => object({ [property]: { const: value } })),
})

function request(mediaType: string, schema: unknown, encoding?: object): Record<string, unknown> {
  return oas("3.1", {
    paths: {
      "/upload": {
        post: {
          requestBody: { content: { [mediaType]: { schema, ...(encoding ? { encoding } : {}) } } },
          responses: { "204": { description: "Done" } },
        },
      },
    },
  })
}

const intersectingDocument = (count: number) =>
  withSchemas("3.1", {
    T: { allOf: [alternatives("left", count), alternatives("right", 100)] },
  })

const encodingWarnings = async (doc: object) => {
  const { diagnostics } = await generate(doc)
  return diagnostics.filter((d) => d.code === "unsupported-request-encoding")
}

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

describe("unsupported Blob request diagnostics", () => {
  it.each(["application/json", "application/x-www-form-urlencoded"])(
    "warns about nested Blob values in %s without changing their types",
    async (mediaType) => {
      const { code, diagnostics } = await generate(request(mediaType, object({ file: binary })))
      expect(diagnostics.filter((d) => d.code === "unsupported-request-encoding")).toMatchObject([
        {
          severity: "warning",
          location: `#/paths/~1upload/post/requestBody/content/${mediaType.replaceAll("/", "~1")}`,
          message: expect.stringContaining("nested Blob"),
        },
      ])
      expect(code).toContain("file?: Blob")
    },
  )

  it("warns for parameter schemas, JSON content, and the whole querystring", async () => {
    const { diagnostics } = await generate(
      oas("3.2", {
        paths: {
          "/upload/{file}": {
            get: {
              parameters: [
                { name: "file", in: "path", required: true, schema: binary },
                {
                  name: "x-file",
                  in: "header",
                  content: { "application/json": { schema: object({ file: binary }) } },
                },
                {
                  name: "all",
                  in: "querystring",
                  content: {
                    "application/x-www-form-urlencoded": { schema: object({ file: binary }) },
                  },
                },
              ],
              responses: { "204": { description: "Done" } },
            },
          },
          "/query": {
            get: {
              parameters: [{ name: "file", in: "query", schema: binary }],
              responses: { "204": { description: "Done" } },
            },
          },
        },
      }),
    )
    const warnings = diagnostics.filter((d) => d.code === "unsupported-request-encoding")
    expect(warnings.map((d) => d.location)).toStrictEqual([
      "#/paths/~1upload~1{file}/get/parameters/0",
      "#/paths/~1upload~1{file}/get/parameters/1",
      "#/paths/~1upload~1{file}/get/parameters/2",
      "#/paths/~1query/get/parameters/0",
    ])
    expect(warnings.every((d) => d.message.includes("encode the bytes"))).toBe(true)
  })

  it.each(["GET", "HEAD", "CONNECT", "TRACE", "TRACK"])(
    "does not suggest body encoding for %s, which cannot send a body",
    async (method) => {
      const operation = {
        requestBody: { content: { "application/json": { schema: object({ file: binary }) } } },
        responses: { "204": { description: "Done" } },
      }
      const path = ["CONNECT", "TRACK"].includes(method)
        ? { additionalOperations: { [method]: operation } }
        : { [method.toLowerCase()]: operation }
      expect(await encodingWarnings(oas("3.2", { paths: { "/upload": path } }))).toStrictEqual([])
    },
  )

  it("follows recursive aliases, arrays, and additional properties", async () => {
    const doc = request("application/json", { $ref: "#/components/schemas/Node" })
    doc.components = {
      schemas: {
        Node: {
          ...object({ next: { $ref: "#/components/schemas/Node" } }),
          additionalProperties: { type: "array", items: binary },
        },
      },
    }
    expect(await encodingWarnings(doc)).toHaveLength(1)
  })

  it.each([
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "application/octet-stream",
  ])("allows ready Blob bodies for %s", async (media) => {
    expect(await encodingWarnings(request(media, binary))).toStrictEqual([])
  })

  it("allows raw multipart files, including arrays and aliases", async () => {
    const doc = request(
      "multipart/form-data",
      object({
        file: { $ref: "#/components/schemas/File" },
        files: { type: "array", items: { $ref: "#/components/schemas/File" } },
      }),
      { file: { contentType: "application/json" } },
    )
    doc.components = { schemas: { File: binary } }
    expect(await encodingWarnings(doc)).toStrictEqual([])
  })

  it.each([
    [object({ nested: object({ file: binary }) }), undefined],
    [object({ files: { type: "array", items: { type: "array", items: binary } } }), undefined],
    [object({ file: binary }), { file: { style: "form" } }],
  ])(
    "warns for multipart binary values that require text serialization",
    async (schema, encoding) => {
      expect(
        await encodingWarnings(request("multipart/form-data", schema, encoding)),
      ).toMatchObject([
        {
          message: expect.stringContaining("ready FormData"),
        },
      ])
    },
  )

  it("does not warn about response-only Blob schemas or encoded text bytes", async () => {
    expect(
      await encodingWarnings(
        oas("3.1", {
          components: { schemas: { File: binary } },
          paths: {
            "/download": {
              get: {
                responses: {
                  "200": {
                    description: "File",
                    content: { "application/json": { schema: object({ file: binary }) } },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toStrictEqual([])
    expect(
      await encodingWarnings(
        request(
          "application/json",
          object({
            file: { type: "string", contentEncoding: "base64", contentMediaType: "image/png" },
          }),
        ),
      ),
    ).toStrictEqual([])
  })
})
