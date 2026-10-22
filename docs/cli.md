# CLI and programmatic API

Generate a TypeScript module from the command line or from code. Use `--check` to detect outdated output.

## CLI

```sh
openapi-shape <source> [-o <file>] [--check]
```

| Option                        | Description                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<source>`                    | Required. Local path or `file:`, HTTP(S) URL of a JSON or YAML OpenAPI document.                                                                            |
| `-o, --output <file>`         | Write a `.ts` or `.mts` module, creating parent directories as needed. `.cts` and declaration files are not supported. Omit this option to write to stdout. |
| `--check`                     | Compare generated output with `<file>` without writing. Requires `--output`. Exit with 1 if the file is missing or differs.                                 |
| `--max-document-size <MiB>`   | Maximum size of each loaded document, as a positive whole number of MiB (1 MiB = 1,048,576 bytes). Default: `10`.                                           |
| `-h, --help`, `-v, --version` | Help and version.                                                                                                                                           |

Unknown options are ignored. When an option is repeated, its last value wins.

### Checking generated files

Use paired scripts to regenerate a committed module and check whether it is current:

```json
{
  "scripts": {
    "api:generate": "openapi-shape ./openapi.yaml -o src/api.ts",
    "api:check": "openapi-shape ./openapi.yaml -o src/api.ts --check"
  }
}
```

`--check` compares the complete generated output, including formatting. For missing or outdated output, rerun without `--check` and commit the generated file.

### Output and exit status

Generated TypeScript goes to the output file or stdout. Diagnostics and command status go to stderr. Warnings do not fail the command. Help and version go to stdout; argument parsing errors also print usage there.

| Exit code | Meaning                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `0`       | Generation succeeded, or `--check` found matching output.                                                             |
| `1`       | Generation failed, arguments were invalid, an output operation failed, or `--check` found missing or outdated output. |

Each diagnostic occupies one line:

```text
openapi.yaml#/components/schemas/User-Profile/type: warning invalid-schema: Unknown type "text"
Wrote src/api.ts (1 warning)
```

Text locations include the source path or URI and a JSON Pointer. Generation and file-operation failures end with `error:` and a description. An outdated file also shows the first differing line as `<file>:<line>:`. Colors are enabled for compatible terminals; `NO_COLOR` and `FORCE_COLOR` apply.

### Atomic file replacement

With `--output`, the CLI writes a complete temporary file beside the destination, then renames it over the destination. A failed write or rename preserves the previous output. `--check` does not create temporary output.

Symbolic links and normal permission bits are preserved. The destination directory must be writable. Replacement creates a new file: hard links retain the old contents, and ownership, ACLs, and special permission bits are not copied.

This protects against partial writes, not power loss. Abrupt termination may leave a temporary file.

## Programmatic API

`generate(input, options?)` accepts a file path, a `URL`, or a parsed document object. It resolves to `{ code, diagnostics }`, where `code` is the generated module and `diagnostics` contains warnings. Document failures reject with a `GenerateError` whose diagnostics describe the failure. Cancellation rejects with `signal.reason`; invalid loading limits reject with a `TypeError`.

```ts
import { generate, GenerateError } from "openapi-shape"

try {
  const { code, diagnostics } = await generate("./openapi.yaml")
  for (const d of diagnostics) console.warn(`${d.code} at ${d.location}: ${d.message}`)
} catch (error) {
  if (error instanceof GenerateError) console.error(error.diagnostics)
  else throw error
}
```

| Option | Description                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base` | The location of a parsed document, as a path or URL, used to resolve relative `$ref`s. Without it, references must stay within the document. Ignored when `input` is a path or URL. |

### Loading and cancellation

| Option                  | Default             | Description                                                                                                                           |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`                | —                   | An `AbortSignal` for the whole generation.                                                                                            |
| `load(uri, { signal })` | Built-in loader     | Return a `Response`, or `undefined` to delegate to the built-in file/HTTP loader, directly or through a promise.                      |
| `maxConcurrentLoads`    | `8`                 | Maximum loads in progress at once. A load, its hook and body reading included, is in progress until it succeeds, fails, or times out. |
| `maxDocumentBytes`      | `10485760` (10 MiB) | Maximum bytes per loaded document, measured from its response stream before parsing.                                                  |

Both limits must be positive safe integers and apply to local files and HTTP(S) sources alike. The byte limit applies to the entry document and every external reference, and counts decompressed HTTP bytes; it does not limit an already parsed input object, total memory, or data a custom loader buffers before returning its response. The CLI sets the byte limit with `--max-document-size`, in MiB, and uses the other defaults:

```sh
openapi-shape api.yaml --max-document-size 50 -o api.ts
```

The exported `DocumentLoader` type describes the hook. It receives absolute `file:`, `http:`, or `https:` URIs without fragments. A response must have a successful status and a body compatible with the runtime's web `ReadableStream`, or `null`; other hook results, including `null`, fail the load. The hook does not bypass [reference boundaries](./openapi.md#references).

The response media type, excluding parameters, selects JSON or YAML parsing. If it does not identify either format, the final URL's extension is used; if that is also unknown, parsing tries JSON, then YAML. A nonempty `Response.url` becomes the base for relative references; otherwise the requested URI does.

For example, authenticate requests to a known origin and delegate other sources:

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

Each load has a 30-second deadline, including the hook and body reading. Its signal combines that deadline with the caller's signal. Pass it to any work the hook starts. Cancellation stops queued loads, cancels active response streams, and rejects promptly even if a hook ignores the signal. Such a hook's own work cannot be stopped: it keeps running after its load times out or is cancelled, no longer counted by `maxConcurrentLoads`, and a response it returns late is discarded.

Synchronous build and render stages run to completion, but no module is returned after cancellation. Any other load failure, such as a timeout, the byte limit, an unsuccessful status, a loader error, or an invalid loader result, is reported as `read-failed` for the entry document or `unresolved-ref` for an external reference.

## Diagnostics

Errors stop generation. Warnings identify invalid input or parts of the description the output cannot apply. Documented [compatibility rules](./openapi.md#following-the-real-api) do not produce warnings.

Each diagnostic has four fields:

| Field      | Meaning                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `severity` | `error` or `warning`.                                                                                     |
| `code`     | A stable identifier listed below.                                                                         |
| `message`  | A description of the issue.                                                                               |
| `location` | A JSON Pointer such as `#/components/schemas/Pet`, prefixed with the document URI for external documents. |

### Diagnostic codes

| Code                           | Severity | Meaning                                                                                                                                                                                                                      |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-document`             | error    | The document is not a JSON object, refers to itself, nests too deeply, or a `patternProperties` match exceeds its 100 ms limit.                                                                                              |
| `unsupported-version`          | error    | The document does not declare a supported OpenAPI 3.0, 3.1, or 3.2 version.                                                                                                                                                  |
| `read-failed`                  | error    | The entry document cannot be read or parsed.                                                                                                                                                                                 |
| `unresolved-ref`               | error    | A `$ref` target is missing, unreadable, or not allowed.                                                                                                                                                                      |
| `circular-ref`                 | error    | Non-schema references form a cycle.                                                                                                                                                                                          |
| `ignored-field`                | warning  | An unapplied field: path or operation servers, a redefined fixed method in `additionalOperations`, `itemSchema` on a non-sequential media type, unsupported multipart encoding, or a form default that cannot be determined. |
| `invalid-schema`               | warning  | An invalid schema value, type, or literal, or an empty `allOf`, `anyOf`, or `oneOf`.                                                                                                                                         |
| `circular-schema`              | warning  | Schemas that refer back through only `allOf`, `anyOf`, `oneOf`, or `$ref`; the cycle is cut.                                                                                                                                 |
| `schema-precision-loss`        | warning  | A composition is widened at a [complexity or mixed-shape boundary](./openapi.md#complexity-limits). The message explains the reason and the location identifies the affected schema.                                         |
| `unsupported-request-encoding` | warning  | An endpoint request declares binary values in a location the client encodes as text or nested JSON. The schema types are preserved; correct the declaration or supply an encoded body where supported.                       |
| `discriminator-mismatch`       | warning  | A discriminator value or branch that conflicts with the schemas.                                                                                                                                                             |
| `invalid-parameter`            | warning  | A malformed or duplicated parameter.                                                                                                                                                                                         |
| `path-parameter-mismatch`      | warning  | Path parameters and the path template disagree.                                                                                                                                                                              |
| `invalid-status-code`          | warning  | A response key that is not a status code, range, or `default`.                                                                                                                                                               |
| `path-item-conflict`           | warning  | A local Path Item field that overrides a field inherited through `$ref`.                                                                                                                                                     |
| `renamed-schema`               | warning  | A schema or input-variant name changed to avoid a collision.                                                                                                                                                                 |
