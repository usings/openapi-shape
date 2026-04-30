// src/generate.ts
import { prepareDocument, loadDocument } from "./loader";
import { buildIR, type BuildOptions } from "./ir";
import { render, type RenderOptions } from "./render";

export interface GenerateOptions extends BuildOptions, RenderOptions {}

export function generate(doc: object, options: GenerateOptions = {}): string {
  const prepared = prepareDocument(doc);
  return render(buildIR(prepared, options), options);
}

export async function generateFromSource(
  source: string | URL,
  options: GenerateOptions = {},
): Promise<string> {
  return render(buildIR(await loadDocument(source), options), options);
}
