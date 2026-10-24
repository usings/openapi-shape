# Generator API

`generate(input, options?)` accepts a path, URL string, `URL`, or parsed document and resolves to `{ code, diagnostics }`. Save `code` and handle warnings in the caller. For generated file checks and file replacement, use the [CLI](./cli.md).

```ts
import { generate, GenerateError } from "openapi-shape"

try {
  const { code, diagnostics } = await generate("./openapi.yaml")
  for (const d of diagnostics) console.warn(`${d.code} at ${d.location}: ${d.message}`)
  console.log(code)
} catch (error) {
  if (error instanceof GenerateError) console.error(error.diagnostics)
  else throw error
}
```

Document failures reject with `GenerateError`, containing errors and any warnings found. Cancellation rejects with `signal.reason`; invalid numeric limits reject with `TypeError`.

## Options

| Option                  | Default             | Purpose                                                                                                                   |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `base`                  | —                   | Location of a parsed document, as a path or URL. Required for references outside it; ignored when input is a path or URL. |
| `signal`                | —                   | Cancel the whole generation.                                                                                              |
| `load(uri, { signal })` | Built-in loader     | Return a `Response`, or `undefined` to delegate, directly or through a promise.                                           |
| `maxConcurrentLoads`    | `8`                 | Maximum active loads, including hooks and response reading.                                                               |
| `maxDocumentBytes`      | `10485760` (10 MiB) | Maximum streamed bytes per document before parsing.                                                                       |

## Loading and cancellation

Use a custom `DocumentLoader` for authentication or caching. Its URI is an absolute `file:`, `http:`, or `https:` address without a fragment. For example, authenticate one origin and delegate other sources:

```ts
import { generate, type DocumentLoader } from "openapi-shape"

const load: DocumentLoader = (uri, { signal }) => {
  if (new URL(uri).origin !== "https://spec.example.com") return undefined
  return fetch(uri, {
    signal,
    redirect: "error",
    headers: { Authorization: `Bearer ${token}` },
  })
}
const { code } = await generate("https://spec.example.com/openapi.yaml", {
  load,
  signal: AbortSignal.timeout(15_000),
  maxConcurrentLoads: 4,
})
```

A loader must return a successful `Response` or `undefined`; `null` is invalid. The response body may be a web `ReadableStream` compatible with the runtime, or `null`. Custom loading still follows the [reference boundaries](./openapi.md#references).

Numeric limits are positive safe integers. Size limits cover the entry and each referenced document, counting decompressed HTTP bytes. They do not bound total memory, parsed input objects, or data buffered by a custom loader before it returns a response.

Each load has a 30-second deadline covering the hook and body reading. The hook's signal combines it with the call signal; pass that signal to work the hook starts. Failed loads produce `read-failed` for the entry or `unresolved-ref` for a reference.

Cancellation stops queued loads, cancels active response bodies, and rejects even if a hook ignores its signal. Such a hook can continue outside the concurrency count; late responses are discarded. Build/render work checks cancellation between work units. Parsing or one large schema can delay cancellation, but a canceled run returns no partial module.

Response media type selects JSON or YAML parsing. If unknown, the final URL's extension is used; otherwise parsing tries JSON, then YAML. A nonempty `Response.url` becomes the base for references; otherwise the requested URI does.

## Diagnostics

Errors stop generation. Warnings identify invalid input, unsupported behavior, or loss of type precision. Documented [compatibility rules](./openapi.md#following-the-real-api) do not produce warnings. Diagnostics are not a complete OpenAPI/JSON Schema validation report, and not every omitted validation constraint produces a warning.

Each generator diagnostic has four fields:

| Field      | Meaning                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `severity` | `error` or `warning`.                                                                                     |
| `code`     | A stable identifier listed below.                                                                         |
| `message`  | A description of the issue.                                                                               |
| `location` | A JSON Pointer such as `#/components/schemas/Pet`, prefixed with the document URI for external documents. |

### Diagnostic codes

| Code                      | Severity | Meaning                                                                                                                                                                              |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid-document`        | error    | The entry value is not an object, an in-memory object graph is cyclic, nesting exceeds processing capacity, or a `patternProperties` match exceeds its 100 ms limit.                 |
| `unsupported-version`     | error    | The entry document does not declare a supported OpenAPI 3.0, 3.1, or 3.2 version.                                                                                                    |
| `read-failed`             | error    | The entry document cannot be read or parsed.                                                                                                                                         |
| `unresolved-ref`          | error    | A reference target is missing, unreadable, unsupported, or not allowed.                                                                                                              |
| `circular-ref`            | error    | Non-schema references form a cycle.                                                                                                                                                  |
| `ignored-field`           | warning  | A field is not applied: for example, path/operation servers, unsupported multipart encoding, or a form default that cannot be determined.                                            |
| `invalid-schema`          | warning  | An invalid schema value, type, or literal, or an empty `allOf`, `anyOf`, or `oneOf`.                                                                                                 |
| `circular-schema`         | warning  | Schemas refer back through only `allOf`, `anyOf`, `oneOf`, or `$ref`; the cycle is cut.                                                                                              |
| `schema-precision-loss`   | warning  | A composition is widened at a [complexity or mixed-shape boundary](./openapi.md#complexity-limits). The message explains the reason and the location identifies the affected schema. |
| `discriminator-mismatch`  | warning  | A discriminator value or branch conflicts with the schemas.                                                                                                                          |
| `invalid-parameter`       | warning  | A malformed or duplicated parameter.                                                                                                                                                 |
| `path-parameter-mismatch` | warning  | Path parameters and the path template disagree.                                                                                                                                      |
| `invalid-status-code`     | warning  | A response key is not a status code, range, or `default`.                                                                                                                            |
| `path-item-conflict`      | warning  | A nearer Path Item field overrides one inherited through `$ref`.                                                                                                                     |
| `renamed-schema`          | warning  | A schema or input-variant name changed to avoid a collision.                                                                                                                         |
