import { buildModel } from "./core/build"
import { loadDocuments } from "./core/load/documents"
import { renderModule } from "./core/render/module"
import type { Diagnostic } from "./core/shared/diagnostics"
import { Diagnostics } from "./core/shared/diagnostics"
import { PatternTimeoutError } from "./core/shared/patterns"

export type { Diagnostic, DiagnosticCode } from "./core/shared/diagnostics"

export interface GenerateOptions {
  /**
   * Where an in-memory document lives (file path or URL), so its relative `$ref`s can be resolved.
   * Ignored when `input` is a path or URL.
   */
  base?: string | URL
}

export interface GenerateResult {
  /** The TypeScript module, which imports nothing: the types, and the runtime `contract`. */
  code: string
  /** Warnings: parts of the description the output cannot apply, or that are not valid. */
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
 * Generate a TypeScript module from an OpenAPI 3.0, 3.1, or 3.2 description: its types, and the
 * runtime `contract` for `openapi-shape/client`.
 *
 * `input` is a file path, a `file:`/`http(s):` URL, or an already parsed document. Referenced
 * documents are loaded as needed. Throws {@link GenerateError} when the description cannot be turned
 * into correct types.
 */
export async function generate(
  input: string | URL | object,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  try {
    return await run(input, options)
  } catch (error) {
    // Deeply nested documents can exhaust the stack at any stage.
    if (!(error instanceof RangeError) && !(error instanceof PatternTimeoutError)) throw error
    throw new GenerateError([
      {
        severity: "error",
        code: "invalid-document",
        message:
          error instanceof PatternTimeoutError
            ? error.message
            : "The description nests too deeply to process (the call stack overflowed)",
        location: "#",
      },
    ])
  }
}

/** Load the description, build its model, and render the module. */
async function run(
  input: string | URL | object,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const loading = new Diagnostics()
  const documents = await loadDocuments(input, options.base, loading)
  if (documents === undefined) throw new GenerateError(loading.list)
  const { model, diagnostics } = await buildModel(documents)
  if (diagnostics.hasErrors) throw new GenerateError(diagnostics.list)
  const code = renderModule(model)
  return { code, diagnostics: diagnostics.list }
}
