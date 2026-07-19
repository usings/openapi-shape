import type { ContractSchema } from "../contract/model"
import { indent, jsdoc } from "./format"
import type { RenderTypeOptions } from "./render-type"
import { objectFieldLines, renderContractType } from "./render-type"

export function renderSchemas(schemas: ContractSchema[], options: RenderTypeOptions = {}): string {
  const aliases: string[] = []
  const interfaces: string[] = []
  // References inside the namespace do not need the `Schemas.` prefix.
  const bodyOptions: RenderTypeOptions = { formats: options.formats }
  for (const s of schemas) {
    const docHeader = s.docs ? jsdoc(s.docs) : ""
    if (s.kind === "interface") {
      const body = objectFieldLines(s.fields, s.index, bodyOptions).join("\n")
      interfaces.push(`${docHeader}export interface ${s.name} {\n${indent(body)}\n}`)
    } else {
      aliases.push(`${docHeader}export type ${s.name} = ${renderContractType(s.type, bodyOptions)}`)
    }
  }
  return `export namespace Schemas {\n${indent([...aliases, ...interfaces].join("\n\n"))}\n}`
}
