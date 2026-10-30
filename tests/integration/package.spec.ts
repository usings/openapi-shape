import { execFile } from "node:child_process"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { withFiles } from "../support/tmp"

const exec = promisify(execFile)
const root = join(import.meta.dirname, "../..")

it("runs the packed public exports, declarations and CLI in an isolated consumer", async () => {
  await exec("pnpm", ["build"], { cwd: root })
  await withFiles({}, async (dir) => {
    const { stdout } = await exec(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        dir,
        "--cache",
        join(dir, "cache"),
      ],
      { cwd: root },
    )
    const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>
    await exec("tar", ["-xzf", join(dir, filename), "-C", dir])
    const consumer = join(dir, "consumer")
    await mkdir(join(consumer, "node_modules"), { recursive: true })
    await symlink(join(dir, "package"), join(consumer, "node_modules/openapi-shape"), "dir")
    // Supply declared generator dependencies locally; package imports still resolve its real exports.
    await symlink(join(root, "node_modules"), join(dir, "package/node_modules"), "dir")
    await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }))
    const source = `import {generate} from 'openapi-shape';
import {createClient} from 'openapi-shape/client';
const {code} = await generate({openapi:'3.1.0',info:{title:'smoke',version:'1'},paths:{'/ping':{get:{responses:{200:{content:{'application/json':{schema:{type:'string'}}}}}}}}});
await (await import('node:fs/promises')).writeFile('api.ts',code);
const {contract} = await import('./api.ts');
const api=createClient(contract,{baseURL:'https://example.test',fetch:async()=>Response.json('pong')});
if((await api.result('GET /ping')).data!=='pong')throw new Error('Invalid packed client');`
    await writeFile(join(consumer, "smoke.mjs"), source)
    await exec(process.execPath, ["--experimental-strip-types", "smoke.mjs"], { cwd: consumer })
    await writeFile(
      join(consumer, "use.ts"),
      `import {contract, type Endpoints} from './api'; import {createClient, type ResponseOf, type EndpointResult} from 'openapi-shape/client'; const api=createClient(contract); const response: ResponseOf<Endpoints, 'GET /ping'>=await api.fetch('GET /ping'); if(response.status===200) response.json() satisfies Promise<string>; const result: EndpointResult<Endpoints, 'GET /ping'>=await api.result('GET /ping'); result.data satisfies string;`,
    )
    await exec(
      join(root, "node_modules/.bin/tsc"),
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "esnext",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "use.ts",
      ],
      { cwd: consumer },
    )
    const cli = await exec(process.execPath, [join(dir, "package/dist/cli.mjs"), "--help"], {
      cwd: consumer,
    })
    expect(cli.stdout).toContain("openapi-shape")
  })
}, 60_000)
