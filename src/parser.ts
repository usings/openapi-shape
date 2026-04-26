import { readFile } from "node:fs/promises";
import { resolveRefs } from "./refs";

export async function readSource(source: string): Promise<any> {
  let text: string;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${source}: ${response.status} ${response.statusText}`);
    }
    text = await response.text();
  } else {
    text = await readFile(source, "utf-8");
  }

  return resolveRefs(JSON.parse(text));
}
