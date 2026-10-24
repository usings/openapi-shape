import type { ExecFileException } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { typecheck } from "./helpers/tsc"

const compiler = vi.hoisted(() => ({
  error: null as ExecFileException | null,
  stdout: "",
  stderr: "",
}))

type RunCompiler = (
  file: string,
  args: string[],
  options: unknown,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void

vi.mock("node:child_process", () => ({
  execFile: vi.fn<RunCompiler>((_file, _args, _options, callback) =>
    callback(compiler.error, compiler.stdout, compiler.stderr),
  ),
}))

describe("typecheck", () => {
  it("reports compiler metrics without hiding type errors", async () => {
    const metrics = vi.fn<(summary: string) => void>()
    compiler.error = Object.assign(new Error("tsc failed"), { code: 2, cmd: "tsc" })
    compiler.stdout =
      "use.ts(1,1): error TS2322: incompatible type\nFiles: 9\nTypes: 42\nInstantiations: 7\nMemory used: 123K\nCheck time: 0.01s\n"
    compiler.stderr = ""
    expect(await typecheck({ "use.ts": "const value: string = 1" }, { metrics })).toBe(
      "use.ts(1,1): error TS2322: incompatible type",
    )
    expect(metrics).toHaveBeenCalledWith(
      "Files: 9\nTypes: 42\nInstantiations: 7\nMemory used: 123K\nCheck time: 0.01s",
    )
    compiler.stdout = "Files: 9\nTypes: 42\n"
    await expect(typecheck({ "use.ts": "const value = 1" }, { metrics })).rejects.toThrow(
      "tsc did not check the files",
    )
    compiler.stderr = "error TS9999: a compiler error on stderr\n"
    expect(await typecheck({ "use.ts": "const value = 1" }, { metrics })).toBe(
      "error TS9999: a compiler error on stderr",
    )
    compiler.error = null
    compiler.stdout = ""
    compiler.stderr = ""
    await expect(typecheck({ "use.ts": "const value = 1" }, { metrics })).rejects.toThrow(
      "tsc did not report extended diagnostics",
    )
  })

  it.each([0, 1, 2])("returns compiler diagnostics for exit code %i", async (code) => {
    compiler.error =
      code === 0 ? null : Object.assign(new Error("tsc failed"), { code, cmd: "tsc" })
    compiler.stdout = code === 0 ? "" : "use.ts(1,1): error TS2322: incompatible type\n"
    compiler.stderr = ""

    expect(await typecheck({ "use.ts": "const value = 1" })).toBe(compiler.stdout.trim())
  })

  it.each([
    ["cannot start", { code: "ENOENT" }, ""],
    ["exits without diagnostics", { code: 1 }, ""],
    ["crashes with output", { code: 99 }, "compiler crashed"],
    ["is terminated", { code: null, signal: "SIGTERM" }, ""],
    ["times out after printing", { code: 1, killed: true }, "partial diagnostics"],
    ["exceeds the output limit", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "truncated"],
  ] as const)("rejects when the compiler %s", async (_name, failure, output) => {
    const error = Object.assign(new Error("compiler failed"), failure)
    compiler.error = error as ExecFileException
    compiler.stdout = ""
    compiler.stderr = output

    await expect(typecheck({ "use.ts": "const value = 1" })).rejects.toMatchObject({
      message: "tsc did not check the files: compiler failed",
      cause: error,
    })
  })
})
