import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import type { Contract } from "../src/client"
import { generate } from "../src/index"
import { codes, gen, genResult, oas } from "./helpers/generate"
import { withFiles } from "./helpers/tmp"
import { expectPassesTsc } from "./helpers/tsc"

// `Security` and the runtime `contract` a generated module exports for openapi-shape/client.

function clientSection(code: string): string {
  return code.slice(code.search(/^\/\*\* (Credentials|How requests)/m))
}

/** The `contract` the generated module exports, imported as a consumer would. */
function contractOf(code: string): Promise<Contract<Record<string, unknown>>> {
  return withFiles({ "api.ts": code }, async (dir) => {
    const module = (await import(pathToFileURL(join(dir, "api.ts")).href)) as {
      contract: Contract<Record<string, unknown>>
    }
    return module.contract
  })
}

const ok = { "200": { description: "OK" } }

describe("runtime contract", () => {
  it("lists servers, security schemes, default security, and the credentials they take", async () => {
    const code = await gen(
      oas("3.1", {
        servers: [
          {
            url: "https://{region}.api.test/{version}",
            variables: { region: { default: "eu" }, version: { default: "v1" } },
          },
          { url: "https://sandbox.api.test/v1" },
        ],
        security: [{ bearer: [] }, {}],
        components: {
          securitySchemes: {
            "bearer": { type: "http", scheme: "Bearer" },
            "key": { type: "apiKey", in: "header", name: "X-Api-Key" },
            "login": { $ref: "#/components/securitySchemes/basic" },
            "basic": { type: "http", scheme: "basic" },
            "oauth": { type: "oauth2", flows: {} },
            "client-cert": { type: "mutualTLS" },
          },
        },
      }),
    )
    expect(clientSection(code)).toBe(
      [
        "/** Credentials for `createClient({ security })`, by security scheme. */",
        "export interface Security {",
        "  bearer?: string",
        "  key?: string",
        "  login?: { username: string; password: string }",
        "  basic?: { username: string; password: string }",
        "  oauth?: string",
        "}",
        "",
        "/** How requests go over the wire, for `createClient({ contract })` from openapi-shape/client. */",
        "export const contract: Contract<Endpoints, Security> = {",
        '  servers: ["https://eu.api.test/v1", "https://sandbox.api.test/v1"],',
        "  security: {",
        '    bearer: { type: "http", scheme: "bearer" },',
        '    key: { type: "apiKey", in: "header", name: "X-Api-Key" },',
        '    login: { type: "http", scheme: "basic" },',
        '    basic: { type: "http", scheme: "basic" },',
        '    oauth: { type: "oauth2" },',
        '    "client-cert": { type: "mutualTLS" },',
        "  },",
        "  requires: [{ bearer: [] }, {}],",
        "  endpoints: {},",
        "}",
        "",
      ].join("\n"),
    )
    expect(code).toContain('import type { Contract } from "openapi-shape/client"')
    await expectPassesTsc(code)
  })

  it("records each endpoint's serialization where it differs from OpenAPI's defaults", async () => {
    const code = await gen(
      oas("3.1", {
        paths: {
          "/items/{id}": {
            servers: [{ url: "https://files.api.test" }],
            get: {
              security: [{ key: [] }],
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  style: "label",
                  schema: { type: "array" },
                },
                { name: "plain", in: "query", schema: { type: "string" } },
                {
                  name: "explicitDefault",
                  in: "query",
                  style: "form",
                  explode: true,
                  schema: { type: "array" },
                },
                {
                  name: "created",
                  in: "query",
                  style: "deepObject",
                  explode: true,
                  schema: { type: "object" },
                },
                { name: "ids", in: "query", style: "pipeDelimited", schema: { type: "array" } },
                { name: "tags", in: "query", explode: false, schema: { type: "array" } },
                { name: "next", in: "query", allowReserved: true, schema: { type: "string" } },
                {
                  name: "filter",
                  in: "query",
                  content: { "application/json": { schema: { type: "object" } } },
                },
                { name: "X-Range", in: "header", explode: true, schema: { type: "object" } },
              ],
              responses: ok,
            },
            put: {
              requestBody: {
                content: {
                  "application/x-www-form-urlencoded": {
                    schema: { type: "object" },
                    encoding: {
                      metadata: { style: "deepObject", explode: true },
                      plain: { contentType: "text/plain" },
                      styled: { style: "form", explode: false, contentType: "application/json" },
                    },
                  },
                },
              },
              responses: ok,
            },
            post: {
              requestBody: {
                content: {
                  "multipart/form-data": {
                    schema: { type: "object" },
                    encoding: { meta: { contentType: "application/json" } },
                  },
                  "application/octet-stream": {},
                },
              },
              responses: ok,
            },
            patch: { requestBody: { content: { "application/json": {} } }, responses: ok },
          },
        },
      }),
    )
    const files = { servers: ["https://files.api.test"] }
    const { endpoints } = await contractOf(code)
    expect(endpoints).toStrictEqual({
      "GET /items/{id}": {
        ...files,
        requires: [{ key: [] }],
        params: { id: { style: "label", explode: false } },
        query: {
          created: { style: "deepObject", explode: true },
          ids: { style: "pipeDelimited", explode: false },
          tags: { style: "form", explode: false },
          next: { style: "form", explode: true, allowReserved: true },
          filter: { contentType: "application/json" },
        },
        headers: { "X-Range": { style: "simple", explode: true } },
      },
      "PUT /items/{id}": {
        ...files,
        contentType: "application/x-www-form-urlencoded",
        encoding: {
          "application/x-www-form-urlencoded": {
            metadata: { style: "deepObject", explode: true },
            plain: { contentType: "text/plain" },
            styled: { style: "form", explode: false },
          },
        },
      },
      // Two media types and neither takes JSON: the call must name one.
      "POST /items/{id}": {
        ...files,
        encoding: { "multipart/form-data": { meta: { contentType: "application/json" } } },
      },
      "PATCH /items/{id}": files,
    })
    await expectPassesTsc(code)
  })

  it("keeps relative server URLs relative for local documents", async () => {
    const code = await gen(oas("3.1", { servers: [{ url: "/v2" }] }))
    const { servers } = await contractOf(code)
    expect(servers).toStrictEqual(["/v2"])
  })

  it("keeps names such as __proto__ as data", async () => {
    // Parsed from JSON, as documents are: `__proto__` is an ordinary key there.
    const doc = JSON.parse(
      JSON.stringify(
        oas("3.1", {
          security: [{ PROTO: [] }],
          paths: {
            "/a": {
              post: {
                parameters: [
                  { name: "PROTO", in: "query", style: "pipeDelimited", schema: { type: "array" } },
                ],
                requestBody: {
                  content: {
                    "application/x-www-form-urlencoded": {
                      schema: { type: "object" },
                      encoding: { PROTO: { style: "deepObject", explode: true } },
                    },
                  },
                },
                responses: ok,
              },
            },
          },
          components: { securitySchemes: { PROTO: { type: "apiKey", in: "query", name: "k" } } },
        }),
      ).replaceAll("PROTO", "__proto__"),
    ) as object
    const code = await gen(doc)
    const { security, requires, endpoints } = await contractOf(code)
    const entry = endpoints["POST /a"]
    for (const map of [
      security,
      requires?.[0],
      entry?.query,
      entry?.encoding?.["application/x-www-form-urlencoded"],
    ]) {
      expect(Object.hasOwn(map ?? {}, "__proto__")).toBe(true)
    }
    await expectPassesTsc(code)
  })

  it("reports security it cannot use, and what it does where none is required", async () => {
    const result = await genResult(
      oas("3.1", {
        security: { bearer: [] },
        paths: {
          "/a": { get: { security: [{ apiKey: [] }], responses: ok } },
          "/b": { get: { responses: ok } },
        },
        components: {
          securitySchemes: {
            bearer: { type: "http", scheme: "bearer" },
            header: { type: "apiKey", in: "Header", name: "X-Key" },
            nameless: { type: "apiKey", in: "query" },
            schemeless: { type: "http" },
            // Names an operation may not use under another type: they still compile.
            constructor: { type: "apiKey", in: "query", name: "c" },
            toString: { type: "http", scheme: "bearer" },
          },
        },
      }),
    )
    expect(codes(result.diagnostics)).toStrictEqual([
      "invalid-security #/paths/~1a/get/security/0/apiKey",
      "invalid-security #/components/securitySchemes/header",
      "invalid-security #/components/securitySchemes/nameless",
      "invalid-security #/components/securitySchemes/schemeless",
      "invalid-security #/security",
      "lenient-security #/components/securitySchemes",
    ])
    const { security } = await contractOf(result.code)
    expect(Object.keys(security ?? {})).toStrictEqual(["bearer", "constructor", "toString"])
    await expectPassesTsc(result.code)
  })

  it("fills server variables, and defaults a remote document's server to its origin", async () => {
    const local = await genResult(
      oas("3.1", {
        servers: [
          { url: "http://127.0.0.1:{port}/{version}", variables: { port: { default: 8443 } } },
        ],
      }),
    )
    const { servers } = await contractOf(local.code)
    expect(servers).toStrictEqual(["http://127.0.0.1:8443/{version}"])
    expect(codes(local.diagnostics)).toStrictEqual([
      "invalid-server #/servers/0",
      "invalid-server #/servers/0",
    ])
    const server = createServer((_, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(oas("3.1")))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const { port } = server.address() as AddressInfo
      const { code } = await generate(`http://127.0.0.1:${port}/api/openapi.json`)
      const remote = await contractOf(code)
      expect(remote.servers).toStrictEqual([`http://127.0.0.1:${port}`])
    } finally {
      server.close()
    }
  })

  it("records the Encoding Objects of a 3.2 form querystring as its fields' encodings", async () => {
    const code = await gen(
      oas("3.2", {
        paths: {
          "/q": {
            get: {
              parameters: [
                {
                  name: "q",
                  in: "querystring",
                  content: {
                    "application/x-www-form-urlencoded": {
                      schema: { type: "object" },
                      encoding: {
                        filter: { style: "deepObject", explode: true },
                        ids: { explode: false },
                      },
                    },
                  },
                },
              ],
              responses: ok,
            },
          },
        },
      }),
    )
    const { endpoints } = await contractOf(code)
    expect(endpoints["GET /q"]).toStrictEqual({
      query: {
        filter: { style: "deepObject", explode: true },
        ids: { style: "form", explode: false },
      },
    })
  })

  it("is left out of declaration files", async () => {
    const doc = oas("3.1", {
      paths: { "/a": { get: { responses: ok } } },
      security: [{ key: [] }],
      components: { securitySchemes: { key: { type: "apiKey", in: "query", name: "k" } } },
    })
    const result = await genResult(doc, { declarations: true })
    expect(result.code).not.toMatch(/contract|Security|openapi-shape\/client/)
    expect(result.diagnostics).toStrictEqual([])
    await expectPassesTsc(result.code)
  })
})
