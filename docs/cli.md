# CLI and programmatic API

## CLI

```sh
openapi-shape <source> [-o <file>] [--check]
```

| Option                        | Description                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<source>`                    | File path or URL of a JSON or YAML OpenAPI document.                                                                                                         |
| `-o, --output <file>`         | Write to `<file>`, a `.ts` or `.mts` module (directories are created); not CommonJS (`.cts`) or a declaration file. Without `-o`, the module goes to stdout. |
| `--check`                     | Exit with 1 if `<file>` is missing or differs; write nothing. Prints the first difference.                                                                   |
| `-h, --help`, `-v, --version` | Help, version.                                                                                                                                               |

Everything but the module goes to stderr as plain lines, for a CI log or an agent as much as for a person: one line per [diagnostic](#diagnostics), as compilers write them, then one line with the outcome.

```text
openapi.yaml#/components/schemas/User-Profile/type: warning invalid-schema: Unknown type "text"
Wrote src/api.ts (1 warning)
```

A diagnostic's location is its file and a JSON Pointer into it. A run that fails ends with `error:` and what failed; before it, `--check` shows the first difference as `<file>:<line>:`. Colors are used only where stderr is a terminal that takes them (`NO_COLOR` and `FORCE_COLOR` apply). The exit code is 0 on success and 1 when generation fails, `--check` finds the file stale, the file cannot be written, or the arguments are invalid; unknown options are ignored, and of a repeated option the last value counts.

```json
{
  "scripts": {
    "api:generate": "openapi-shape ./openapi.yaml -o src/api.ts",
    "api:check": "openapi-shape ./openapi.yaml -o src/api.ts --check"
  }
}
```

## Programmatic API

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

`generate(input, options?)` takes a file path, a `URL`, or an already parsed document object, and resolves to `{ code, diagnostics }`. If the description cannot be turned into correct types, it rejects with a `GenerateError` whose `diagnostics` lists every error found.

| Option | Description                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `base` | For a parsed document: its location (path or URL), so relative `$ref`s can be resolved. Without it, references must stay inside the document. |

## Diagnostics

A warning marks a part of the description the output cannot apply, or one that is not valid; where the output follows a document's evident intent over the letter of its version, it does so without one ([Following the real API](./openapi.md#following-the-real-api)). Each diagnostic has a `severity`, a stable `code`, a `message`, and a `location`. The location is a JSON Pointer such as `#/components/schemas/Pet`, prefixed with the document URI for other documents.

| Code                      | Severity | Meaning                                                                                                                                                                                     |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-document`        | error    | The document is not a JSON object, refers to itself, or nests too deeply.                                                                                                                   |
| `unsupported-version`     | error    | Not OpenAPI 3.0–3.2.                                                                                                                                                                        |
| `read-failed`             | error    | The entry document cannot be read or parsed.                                                                                                                                                |
| `unresolved-ref`          | error    | A `$ref` target is missing, unreadable, or not allowed.                                                                                                                                     |
| `circular-ref`            | error    | Non-schema references form a cycle.                                                                                                                                                         |
| `ignored-field`           | warning  | A field the output cannot apply: the servers of a path or operation, an `additionalOperations` entry that redefines a fixed method, or `itemSchema` on a media type that is not a sequence. |
| `invalid-schema`          | warning  | A schema value, `type`, or literal that is not valid, or an empty `allOf`/`anyOf`/`oneOf`.                                                                                                  |
| `circular-schema`         | warning  | Schemas defined only through each other via `allOf`/`anyOf`/`oneOf`/`$ref`; the cycle is cut.                                                                                               |
| `discriminator-mismatch`  | warning  | A discriminator value or branch that the schemas contradict.                                                                                                                                |
| `invalid-parameter`       | warning  | A malformed or duplicated parameter.                                                                                                                                                        |
| `path-parameter-mismatch` | warning  | Path parameters and the path template disagree.                                                                                                                                             |
| `invalid-status-code`     | warning  | A response key that is not a status code, range, or `default`.                                                                                                                              |
| `path-item-conflict`      | warning  | A field defined both by a Path Item and the Path Item it references.                                                                                                                        |
| `renamed-schema`          | warning  | A schema name that collided with another after sanitizing.                                                                                                                                  |
