import { buildContract } from "./core/contract/build"
import { renderDeclarations } from "./core/declarations/render"
import { DocumentSet } from "./core/openapi/documents"
import type { Diagnostic } from "./core/shared/diagnostics"
import { Diagnostics } from "./core/shared/diagnostics"

export type { Diagnostic, DiagnosticCode } from "./core/shared/diagnostics"

export interface GenerateOptions {
  /**
   * Map OpenAPI `format` values to TypeScript types, for example
   * `{ "date-time": "Date", "int64": "bigint" }`. Applies to strings and
   * numbers; `binary` sets the type of raw binary content (default `Blob`).
   * Values are emitted verbatim.
   */
  formats?: Record<string, string>
  /**
   * Where an in-memory document lives (file path or URL), so its relative
   * `$ref`s can be resolved. Ignored when `input` is a path or URL.
   */
  base?: string | URL
  /**
   * Emit types only, for a `.d.ts` file: no `Security` or runtime `contract`, so
   * the module cannot drive `openapi-shape/client`.
   */
  declarations?: boolean
}

export interface GenerateResult {
  /** The TypeScript module: the types, and `Security` and the runtime `contract` unless `declarations` is set. */
  code: string
  /**
   * Warnings: where the output departs from the letter of the specification,
   * to follow what the API does (`lenient-*`), or ignores or approximates something.
   */
  diagnostics: Diagnostic[]
}

/** Generation failed; `diagnostics` holds every error (and any warnings) found. */
export class GenerateError extends Error {
  readonly diagnostics: Diagnostic[]

  constructor(diagnostics: Diagnostic[]) {
    const errors = diagnostics.filter((d) => d.severity === "error")
    const [first] = errors
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more errors)` : ""
    super(first ? `${first.message} at ${first.location}${more}` : "Generation failed")
    this.name = "GenerateError"
    this.diagnostics = diagnostics
  }
}

/**
 * Generate a TypeScript module from an OpenAPI 3.0, 3.1, or 3.2 description:
 * its types, and the runtime `contract` for `openapi-shape/client`.
 *
 * `input` is a file path, a `file:`/`http(s):` URL, or an already parsed
 * document. Referenced documents are loaded as needed. Throws
 * {@link GenerateError} when the description cannot be turned into correct types.
 */
export async function generate(
  input: string | URL | object,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  try {
    return await run(input, options)
  } catch (error) {
    // Deeply nested documents can exhaust the stack at any stage.
    if (!(error instanceof RangeError)) throw error
    throw new GenerateError([
      {
        severity: "error",
        code: "invalid-document",
        message: "The description nests too deeply to process (the call stack overflowed)",
        location: "#",
      },
    ])
  }
}

async function run(
  input: string | URL | object,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const opening = new Diagnostics()
  const docs = await DocumentSet.open(input, options.base, opening)
  if (docs === undefined) throw new GenerateError(opening.list)

  for (;;) {
    const diagnostics = new Diagnostics()
    const contract = buildContract(docs, diagnostics)
    if (docs.hasPending) {
      // oxlint-disable-next-line no-await-in-loop -- each round needs the documents the previous one asked for
      if (await docs.loadPending()) continue
      diagnostics.error("unresolved-ref", "References nest too deeply across documents", "#")
    }
    if (diagnostics.hasErrors) throw new GenerateError(diagnostics.list)
    return { code: renderDeclarations(contract, options), diagnostics: diagnostics.list }
  }
}
