import { execFile } from "node:child_process"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { withFiles } from "./helpers/tmp"

const ROOT = join(import.meta.dirname, "..")
const exec = promisify(execFile)

it("uses the packed CLI, generator and client from an isolated TypeScript application", async () => {
  await withFiles(
    {
      "package.json": { private: true, type: "module" },
      "openapi.yaml": await readFile(join(ROOT, "tests/fixtures/readme.yaml"), "utf8"),
      "tsconfig.json": {
        compilerOptions: {
          target: "es2022",
          module: "nodenext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          types: [],
          lib: ["es2022", "dom", "dom.iterable"],
          outDir: "out",
        },
        include: ["*.ts"],
      },
      "consumer.ts": `
import { generate } from "openapi-shape"
import { createClient } from "openapi-shape/client"
import { contract } from "./api.js"

const { code, diagnostics } = await generate("./openapi.yaml")
if (!code.includes("export const contract") || diagnostics.length) throw new Error("Generation failed")
const api = createClient(contract, {
  baseUrl: "https://api.example.com/v1",
  fetch: async (request) => {
    if (request.url !== "https://api.example.com/v1/pets?limit=10") throw new Error(request.url)
    return Response.json([{ id: 1, name: "Milo" }])
  },
})
const { data, error } = await api.result("GET /pets", { query: { limit: 10 } })
if (error !== undefined) throw new Error(error?.message ?? "Request failed")
console.log(data.map(pet => pet.name).join(","))

function invalidCalls() {
  // @ts-expect-error the packed declarations must preserve required path parameters
  api.fetch("GET /pets/{petId}")
  // @ts-expect-error the packed declarations must reject unknown endpoints
  api.fetch("GET /missing")
}
`,
    },
    async (dir) => {
      const options = { cwd: ROOT, timeout: 60_000, maxBuffer: 1024 * 1024 }
      await exec(join(ROOT, "node_modules/.bin/tsdown"), [], options)
      const { stdout } = await exec(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", dir],
        { ...options, env: { ...process.env, npm_config_cache: join(dir, "npm-cache") } },
      )
      const [packed] = JSON.parse(stdout) as Array<{ filename: string }>
      const installed = join(dir, "node_modules/openapi-shape")
      await mkdir(installed, { recursive: true })
      await exec(
        "tar",
        ["-xzf", join(dir, packed.filename), "-C", installed, "--strip-components=1"],
        options,
      )
      const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
        bin: Record<string, string>
        dependencies: Record<string, string>
      }
      // Reuse only declared production dependencies; no registry or source aliases are involved.
      await Promise.all(
        Object.keys(manifest.dependencies).map((name) =>
          symlink(join(ROOT, "node_modules", name), join(dir, "node_modules", name), "dir"),
        ),
      )
      const bin = join(installed, manifest.bin["openapi-shape"])
      const command = join(dir, "node_modules/.bin/openapi-shape")
      await mkdir(join(dir, "node_modules/.bin"))
      await symlink(bin, command)
      const run = (args: string[]) => exec(command, args, { ...options, cwd: dir })
      await expect(run(["openapi.yaml", "-o", "api.ts", "--check"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("does not exist"),
      })
      await run(["openapi.yaml", "-o", "api.ts"])
      await expect(run(["openapi.yaml", "-o", "api.ts", "--check"])).resolves.toMatchObject({
        stdout: "",
        stderr: expect.stringContaining("is up to date"),
      })
      await exec(join(ROOT, "node_modules/.bin/tsc"), ["--project", "tsconfig.json"], {
        ...options,
        cwd: dir,
      })
      await expect(
        exec(process.execPath, ["out/consumer.js"], { ...options, cwd: dir }),
      ).resolves.toMatchObject({ stdout: "Milo\n" })

      const generated = await readFile(join(dir, "api.ts"), "utf8")
      const edited = generated.replace("born?: string", "born?: Date")
      expect(edited).not.toBe(generated)
      await writeFile(join(dir, "api.ts"), edited)
      await expect(run(["openapi.yaml", "-o", "api.ts", "--check"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(
          /api\.ts:(\d+): expected:[^\n]*born\?: string\napi\.ts:\1: found:[^\n]*born\?: Date[\s\S]*is out of date/,
        ),
      })
      expect(await readFile(join(dir, "api.ts"), "utf8")).toBe(edited)
    },
  )
}, 60_000)
