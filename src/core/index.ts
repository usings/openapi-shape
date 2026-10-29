import { buildModel } from "./build"
import type { Diagnostic } from "./diagnostics"
import { Diagnostics } from "./diagnostics"
import type { LoadingOptions } from "./document-reader"
import { DocumentReader } from "./document-reader"
import { loadDocuments } from "./documents"
import { GenerationControl, GenerationLimitError } from "./generation-control"
import { PatternTimeoutError } from "./patterns"
import { prepareOutput } from "./prepare-output"
import { renderModule } from "./render-module"

export type { Diagnostic, DiagnosticCode } from "./diagnostics"
export type { DocumentLoader } from "./document-reader"

export interface GenerateOptions extends LoadingOptions {
  /** Cancel loading and stop at generation checkpoints; rejection preserves signal.reason. */
  signal?: AbortSignal
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
 * `input` is a file path, a `file:`/`http(s):` URL, or an already parsed document. URI inputs load
 * referenced documents as needed; parsed objects can reference only their own resources. Use an
 * entry URI and `loader` to load an in-memory document with external references. Throws
 * {@link GenerateError} when the description cannot be turned into correct types. Cancellation
 * rejects with `signal.reason`; invalid loading limits throw TypeError.
 */
export async function generate(
  input: string | URL | object,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const control = new GenerationControl(options.signal)
  control.throwIfAborted()
  const reader = new DocumentReader(options, control)
  try {
    return await run(input, reader, control)
  } catch (error) {
    control.throwIfAborted()
    // Deeply nested documents can exhaust the stack at any stage.
    if (
      !(error instanceof RangeError) &&
      !(error instanceof PatternTimeoutError) &&
      !(error instanceof GenerationLimitError)
    )
      throw error
    throw new GenerateError([
      {
        severity: "error",
        code: "invalid-document",
        message:
          error instanceof PatternTimeoutError || error instanceof GenerationLimitError
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
  reader: DocumentReader,
  control: GenerationControl,
): Promise<GenerateResult> {
  const loading = new Diagnostics()
  const documents = await loadDocuments(input, loading, reader, control)
  if (documents === undefined) throw new GenerateError(loading.list)
  const { model, diagnostics } = await buildModel(documents, control)
  if (diagnostics.hasErrors) throw new GenerateError(diagnostics.list)
  await control.checkpoint()
  const output = await prepareOutput(model, () => control.workpoint())
  const code = await renderModule(output, () => control.workpoint())
  await control.checkpoint()
  return { code, diagnostics: diagnostics.list }
}
