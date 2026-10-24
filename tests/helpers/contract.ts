import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Contract } from "../../src/client"
import { withFiles } from "./tmp"

/** Minimal descriptive operation for transport tests; body inputs are grouped by media type. */
export type ResultOperation<Request = Record<never, never>> = {
  [K in keyof Request as K extends "contentType" ? never : K]: K extends "body"
    ? Record<
        Request extends { contentType?: infer Media extends string } ? Media : "application/json",
        Request[K]
      >
    : Request[K]
} & {
  responses: { 200: { content: { "application/json": unknown } } }
}

/** Import a generated contract as a consumer would, with each call isolated in its own module. */
export function contractOf<Endpoints = Record<string, ResultOperation>>(
  code: string,
): Promise<Contract<Endpoints>> {
  return withFiles({ "api.ts": code }, async (dir) => {
    const module = (await import(pathToFileURL(join(dir, "api.ts")).href)) as {
      contract: Contract<Endpoints>
    }
    return module.contract
  })
}
