import { readSource } from "./parser";
import { resolveRefs } from "./refs";
import { injectDiscriminators } from "./discriminator";
import { generateRoutes } from "./routes";
import { generateSchemas } from "./schemas";

export function generate(openapi: any): string {
  const resolvedOpenapi = resolveRefs(openapi);
  const injectedOpenapi = injectDiscriminators(resolvedOpenapi);
  const parts: string[] = [];

  if (injectedOpenapi.paths) {
    parts.push(generateRoutes(injectedOpenapi.paths));
  }

  if (injectedOpenapi.components?.schemas) {
    parts.push(generateSchemas(injectedOpenapi.components.schemas));
  }

  return parts.join("\n\n") + "\n";
}

export async function generateFromSource(source: string): Promise<string> {
  const openapi = await readSource(source);
  return generate(openapi);
}
