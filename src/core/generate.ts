import { buildIR } from "./build";
import type { BuildOptions } from "./build";
import { prepareDocument, loadDocument } from "./load";
import { render } from "./render";
import type { RenderOptions } from "./render";

export interface GenerateOptions extends BuildOptions, RenderOptions {}

function generateFromDocument(doc: object, options: GenerateOptions): string {
  const prepared = prepareDocument(doc);
  return render(buildIR(prepared, options), options);
}

async function generateFromSource(source: string | URL, options: GenerateOptions): Promise<string> {
  return render(buildIR(await loadDocument(source), options), options);
}

export function generate(source: string | URL, options?: GenerateOptions): Promise<string>;
export function generate(doc: object, options?: GenerateOptions): string;
export function generate(
  input: object | string | URL,
  options: GenerateOptions = {},
): string | Promise<string> {
  if (typeof input === "string" || input instanceof URL) {
    return generateFromSource(input, options);
  }
  return generateFromDocument(input, options);
}
