import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Contract } from "../../src/client"
import { withFiles } from "./tmp"

/** Import a generated contract as a consumer would, with each call isolated in its own module. */
export function contractOf<Endpoints = Record<string, { responses: object }>>(
  code: string,
): Promise<Contract<Endpoints>> {
  return withFiles({ "api.ts": code }, async (dir) => {
    const module = (await import(pathToFileURL(join(dir, "api.ts")).href)) as {
      contract: Contract<Endpoints>
    }
    return module.contract
  })
}
