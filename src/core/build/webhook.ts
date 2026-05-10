import type { OpenAPIDocument } from "../load/openapi";
import { walkPathItems } from "./endpoint";
import type { BuildOptions } from "./index";
import type { EndpointModel } from "./ir";

export function buildWebhooks(doc: OpenAPIDocument, options: BuildOptions): EndpointModel[] {
  return walkPathItems(doc.webhooks ?? {}, "/webhooks", options);
}
