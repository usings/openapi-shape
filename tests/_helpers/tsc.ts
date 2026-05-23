import { spawn } from "node:child_process"
import { join } from "node:path"
import { expect } from "vitest"
import { withTmpFiles } from "./tmp"

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

export async function expectPassesTsc(codes: string[]): Promise<void> {
  await withTmpFiles(
    codes,
    async (paths) => {
      const tsc = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsc")
      await expect(
        run(tsc, ["--ignoreConfig", "--noEmit", "--strict", "--target", "esnext", ...paths]),
      ).resolves.toBeUndefined()
    },
    { ext: ".d.ts", prefix: "openapi-dts-test" },
  )
}
