import { generate } from "../../src/core/index"
import type { Version } from "./generate"
import { oas } from "./generate"
import { typecheck } from "./tsc"

/** Compile the decoded result or stream item for one generated response media declaration. */
export async function contentTypeErrors(
  mediaType: string,
  media: object,
  expected: string,
  version: Version = "3.1",
  output: "EndpointData" | "EndpointStreamItem" = "EndpointData",
): Promise<string> {
  const { code } = await generate(
    oas(version, {
      paths: { "/r": { get: { responses: { "200": { content: { [mediaType]: media } } } } } },
    }),
  )
  return typecheck({
    "file0.ts": code,
    "use.ts": `
import type { ${output} } from "openapi-shape/client"
import type { Endpoints } from "./file0"
type Actual = ${output}<Endpoints, "GET /r">
type Expected = ${expected}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const equal: Equal<Actual, Expected> = true
`,
  })
}
