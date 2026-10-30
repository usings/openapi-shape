import { resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"
import { gen, oas } from "../support/generate"

it("suggests generated response headers by status while retaining native values", async () => {
  const responses = {
    "200": { headers: { "X-Total": { required: true, schema: { type: "integer" } } } },
    "2XX": { headers: { "X-Range": { schema: { type: "string" } } } },
    "204": { headers: { ETag: { schema: { type: "string" } } } },
    "304": { headers: { "Last-Modified": { schema: { type: "string" } } } },
    "4XX": { headers: { "X-Error": { schema: { type: "string" } } } },
    "default": { headers: { "X-Fallback": { schema: { type: "string" } } } },
  }
  const code = await gen(
    oas("3.1", { paths: { "/items": { get: { responses }, head: { responses } } } }),
  )
  const root = resolve(import.meta.dirname, "../..")
  const main = resolve(root, ".cache/response-header-consumer.ts")
  const generated = resolve(root, ".cache/response-header-api.ts")
  const source = `import {createClient} from 'openapi-shape/client';
import {contract} from './response-header-api';
const api=createClient(contract);
async function forwarded(){ return api.result('GET /items') }
const result=await forwarded();
if(result.status===200) result.response.headers.get(""); // result200
if(result.status===201) result.response.headers.get(""); // result201
if(result.status===204) result.response.headers.has(""); // result204
if(result.status===304) result.response.headers.get(""); // result304
if(result.status===404) result.response.headers.get(""); // result404
if(result.status===500) result.response.headers.get(""); // result500
const response=await api.fetch('GET /items');
if(response.status===200) {
 response.headers.get(""); // fetch200
 response.headers.get('X-Total') satisfies string|null;
 response.headers.get('unknown-header') satisfies string|null;
 const name: string='dynamic'; response.headers.has(name) satisfies boolean;
 // @ts-expect-error numeric schemas do not deserialize headers
 response.headers.get('x-total') satisfies number;
 // @ts-expect-error required declarations do not guarantee visibility or presence
 response.headers.get('x-total') satisfies string;
}
const head=await api.fetch('HEAD /items');
if(head.status===200) head.headers.get(""); // head200
if(head.status===204) head.headers.get(""); // head204
const native: Response=response;
const headers: Headers=response.headers;
`
  const files = new Map([
    [main, source],
    [generated, code],
  ])
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
    paths: { "openapi-shape/client": [resolve(root, "src/client/index.ts")] },
  }
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "0",
    getScriptSnapshot: (name) => {
      const text = files.get(name) ?? ts.sys.readFile(name)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (name) => files.has(name) || ts.sys.fileExists(name),
    readFile: (name) => files.get(name) ?? ts.sys.readFile(name),
  }
  const service = ts.createLanguageService(host)
  try {
    expect(
      service
        .getSemanticDiagnostics(main)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toStrictEqual([])
    for (const [marker, name] of Object.entries({
      result200: "x-total",
      result201: "x-range",
      result204: "etag",
      result304: "last-modified",
      result404: "x-error",
      result500: "x-fallback",
      fetch200: "x-total",
      head200: "x-total",
      head204: "etag",
    })) {
      const position = source.indexOf(`""); // ${marker}`) + 1
      const entries =
        service.getCompletionsAtPosition(main, position, {})?.entries.map((entry) => entry.name) ??
        []
      expect(entries).toContain(name)
      expect(entries).not.toContain(name === "x-error" ? "x-total" : "x-error")
    }
  } finally {
    service.dispose()
  }
})
