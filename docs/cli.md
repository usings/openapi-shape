# CLI and programmatic API

Generate a module from a local file or URL, check committed output for changes, or call the generator from code. Both interfaces report structured [diagnostics](#diagnostics).

## CLI

```sh
openapi-shape <source> [-o <file>] [--check]
```

| Option                        | Description                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<source>`                    | File path or URL of a JSON or YAML OpenAPI document.                                                                                                                  |
| `-o, --output <file>`         | Write a `.ts` or `.mts` module, creating parent directories as needed. `.cts` and declaration files are not supported. Omit this option to write to stdout.           |
| `--check`                     | Compare generated output with `<file>` without writing. Requires `--output`. Exit with 1 if the file is missing or differs; show the first difference when it exists. |
| `-h, --help`, `-v, --version` | Help, version.                                                                                                                                                        |

### Checking generated files

Use paired scripts to regenerate a committed module locally and check it in CI:

```json
{
  "scripts": {
    "api:generate": "openapi-shape ./openapi.yaml -o src/api.ts",
    "api:check": "openapi-shape ./openapi.yaml -o src/api.ts --check"
  }
}
```

### Output and exit status

The generated module goes to the output file or stdout. Diagnostics and command results go to stderr, with one diagnostic per line:

```text
openapi.yaml#/components/schemas/User-Profile/type: warning invalid-schema: Unknown type "text"
Wrote src/api.ts (1 warning)
```

Locations contain the source file and a JSON Pointer. Failed runs end with `error:` and a description of the failure. When `--check` finds a difference, it prints the first differing line as `<file>:<line>:` before the failure message.

| Exit code | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`       | Generation succeeded, or `--check` found matching output.                                                              |
| `1`       | Generation failed, output could not be written, arguments were invalid, or `--check` found missing or outdated output. |

Colors are enabled when stderr is a compatible terminal; `NO_COLOR` and `FORCE_COLOR` apply. Unknown options are ignored. When an option is repeated, its last value wins.

## Programmatic API

`generate(input, options?)` accepts a file path, a `URL`, or a parsed document object. It resolves to `{ code, diagnostics }`, where `code` is the generated module and `diagnostics` contains warnings. If generation fails, it rejects with a `GenerateError` whose diagnostics describe the failure.

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

| Code                      | Severity | Meaning                                                                                                                                            |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-document`        | error    | The document is not a JSON object, refers to itself, nests too deeply, or a `patternProperties` match exceeds its 100 ms limit.                    |
| `unsupported-version`     | error    | The document does not declare a supported OpenAPI 3.0, 3.1, or 3.2 version.                                                                        |
| `read-failed`             | error    | The entry document cannot be read or parsed.                                                                                                       |
| `unresolved-ref`          | error    | A `$ref` target is missing, unreadable, or not allowed.                                                                                            |
| `circular-ref`            | error    | Non-schema references form a cycle.                                                                                                                |
| `ignored-field`           | warning  | An unapplied field: path or operation servers, a redefined fixed method in `additionalOperations`, or `itemSchema` on a non-sequential media type. |
| `invalid-schema`          | warning  | An invalid schema value, type, or literal, or an empty `allOf`, `anyOf`, or `oneOf`.                                                               |
| `circular-schema`         | warning  | Schemas that refer back through only `allOf`, `anyOf`, `oneOf`, or `$ref`; the cycle is cut.                                                       |
| `discriminator-mismatch`  | warning  | A discriminator value or branch that conflicts with the schemas.                                                                                   |
| `invalid-parameter`       | warning  | A malformed or duplicated parameter.                                                                                                               |
| `path-parameter-mismatch` | warning  | Path parameters and the path template disagree.                                                                                                    |
| `invalid-status-code`     | warning  | A response key that is not a status code, range, or `default`.                                                                                     |
| `path-item-conflict`      | warning  | A local Path Item field that overrides a field inherited through `$ref`.                                                                           |
| `renamed-schema`          | warning  | A schema or input-variant name changed to avoid a collision.                                                                                       |
