import { loadContract, prepareContract } from "./core/contract";
import type { DeclarationOptions } from "./core/declarations";
import { render } from "./core/declarations";

export type GenerateOptions = DeclarationOptions;

async function generateFromSource(
  source: string | URL,
  options: GenerateOptions = {},
): Promise<string> {
  return render(await loadContract(source), options);
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
  return render(prepareContract(input), options);
}
