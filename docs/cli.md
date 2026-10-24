# CLI

Generate a TypeScript module from an OpenAPI description. To integrate generation into an application or build tool, use the [generator API](./generator.md).

```sh
openapi-shape ./openapi.yaml -o src/api.ts
```

| Argument or option            | Purpose                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `<source>`                    | Required JSON/YAML source: a local path, `file:` URL, or HTTP(S) URL.                                                       |
| `-o, --output <file>`         | Write a `.ts` or `.mts` module, creating parent directories. Omit for stdout. Declaration files and `.cts` are unsupported. |
| `--check`                     | Compare with `--output` without writing; requires that option.                                                              |
| `--max-document-size <MiB>`   | Positive whole-number size limit per document. Default: 10 MiB.                                                             |
| `-h, --help`, `-v, --version` | Help or package version.                                                                                                    |

Unknown options are ignored; repeated options use their last value. The size limit uses MiB (1 MiB = 1,048,576 bytes). See [loading and cancellation](./generator.md#loading-and-cancellation) for shared retrieval limits.

## Checking generated files

Commit generated modules and use paired scripts for local regeneration and CI:

```json
{
  "scripts": {
    "api:generate": "openapi-shape ./openapi.yaml -o src/api.ts",
    "api:check": "openapi-shape ./openapi.yaml -o src/api.ts --check"
  }
}
```

`--check` compares the complete UTF-8 output byte for byte, including formatting, and writes nothing. If output is missing or outdated, rerun without `--check`. See [contract format compatibility](./generated.md#format-compatibility) after package upgrades.

## Output and exit status

Generated code goes to the output file or stdout; diagnostics and command status go to stderr. Warnings do not fail generation. Exit `0` means success or matching output; exit `1` means invalid arguments, a generation or file-operation failure, or missing/outdated output.

```text
openapi.yaml#/components/schemas/User-Profile/type: warning invalid-schema: Unknown type "text"
Wrote src/api.ts (1 warning)
```

Locations contain the source path/URI and a JSON Pointer. See [diagnostics](./generator.md#diagnostics) for the diagnostic fields and code reference. Errors include a description; an outdated output also shows its first differing line. Help and version go to stdout; argument parsing errors print usage there too. `NO_COLOR` and `FORCE_COLOR` control diagnostic colors.

With `--output`, a complete temporary file is renamed over the destination so a failed write or rename preserves the previous file. Filesystem details are in [atomic file replacement](#atomic-file-replacement).

## Atomic file replacement

The CLI writes a temporary file beside the resolved destination, then renames it over that destination. `--check` creates no temporary output. Existing symlinks and normal permission bits are preserved; the destination directory must be writable.

Output paths follow filesystem traversal, resolving directory symlinks before a following `..`, for both writing and checking. For example, if `alias` points to `real/nested`, `-o alias/../api.ts` addresses `real/api.ts`. Missing output parent directories are created, but missing directories behind a dangling output symlink are not.

Replacement creates a new file. Hard links retain the old contents; ownership, ACLs, and special permission bits are not copied. This prevents partial output, not power-loss corruption. Abrupt termination may leave a temporary file.
