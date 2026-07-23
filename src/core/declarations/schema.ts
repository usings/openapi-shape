import type { ContractSchema } from "../contract/model"
import { indent, jsdoc } from "./format"
import type { RenderTypeOptions } from "./render-type"
import { objectFieldLines, renderContractType } from "./render-type"

// References inside the namespace do not need the `Schemas.` prefix, so only
// `formats` is accepted.
export function renderSchemas(
  schemas: ContractSchema[],
  options: Pick<RenderTypeOptions, "formats"> = {},
): string {
  const aliases: string[] = []
  const interfaces: string[] = []
  for (const s of schemas) {
    const docHeader = s.docs ? jsdoc(s.docs) : ""
    if (s.kind === "interface") {
      const body = objectFieldLines(s.fields, s.index, options).join("\n")
      interfaces.push(`${docHeader}export interface ${s.name} {\n${indent(body)}\n}`)
    } else {
      aliases.push(`${docHeader}export type ${s.name} = ${renderContractType(s.type, options)}`)
    }
  }
  return `export namespace Schemas {\n${indent([...aliases, ...interfaces].join("\n\n"))}\n}`
}
