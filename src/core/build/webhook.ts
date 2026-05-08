import type { OpenAPIDocument } from "../load/openapi";
import type { EndpointModel } from "./ir";
import type { BuildOptions } from "./index";
import { walkPathItems } from "./endpoint";

export function buildWebhooks(doc: OpenAPIDocument, options: BuildOptions): EndpointModel[] {
  return walkPathItems(doc.webhooks ?? {}, "/webhooks", options);
}
