import { buildContract } from "./build";
import type { Contract } from "./contract";
import { loadDocument, prepareDocument } from "./document";

export async function loadContract(source: string | URL): Promise<Contract> {
  return buildContract(await loadDocument(source));
}

export function prepareContract(raw: unknown): Contract {
  return buildContract(prepareDocument(raw));
}
