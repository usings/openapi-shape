import { createContext, Script } from "node:vm"

const MATCH_TIMEOUT = 100

// Only this fixed program runs in the context. Patterns and names are string data, never code.
// Compilation and matching both run under the deadline, including the non-Unicode fallback.
const match = new Script(`(() => {
  let regex
  try {
    regex = new RegExp(pattern, "u")
  } catch {
    try { regex = new RegExp(pattern) } catch { return undefined }
  }
  return regex.test(name)
})()`)
const input = { pattern: "", name: "" }
const context = createContext(input)

export class PatternTimeoutError extends Error {
  constructor(pattern: string, name: string) {
    super(
      `A patternProperties match exceeded ${MATCH_TIMEOUT} ms: ${JSON.stringify(pattern)} against ${JSON.stringify(name)}`,
    )
    this.name = "PatternTimeoutError"
  }
}

/** Match a property name, with a deadline; invalid JavaScript expressions stay unknown. */
export function matchesPattern(pattern: string, name: string): boolean | undefined {
  input.pattern = pattern
  input.name = name
  try {
    const result: unknown = match.runInContext(context, { timeout: MATCH_TIMEOUT })
    return typeof result === "boolean" ? result : undefined
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
    ) {
      throw new PatternTimeoutError(pattern, name)
    }
    throw error
  } finally {
    // Calls are synchronous; reuse the context without retaining a document's strings.
    input.pattern = ""
    input.name = ""
  }
}
