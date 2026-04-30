// src/loader/refs.ts
import type {
  OpenAPIDocument,
  Parameter,
  PathItem,
  Operation,
  RequestBody,
  Response,
} from "../types/openapi";
import { LoadError } from "../errors";

const BUCKETS = {
  pathItems: "#/components/pathItems/",
  parameters: "#/components/parameters/",
  requestBodies: "#/components/requestBodies/",
  responses: "#/components/responses/",
} as const;

type Bucket = keyof typeof BUCKETS;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRef(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const ref = (value as { $ref?: unknown }).$ref;
  return typeof ref === "string" ? ref : undefined;
}

function lookup(doc: OpenAPIDocument, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const s of segments) {
    if (!isObject(cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

function follow(doc: OpenAPIDocument, ref: string, location: string, seen: string[] = []): unknown {
  if (seen.includes(ref)) {
    throw new LoadError(`circular ref at ${location}: ${[...seen, ref].join(" → ")}`);
  }
  const target = lookup(doc, ref);
  if (target == null) {
    throw new LoadError(`ref not found at ${location}: ${ref}`);
  }
  const innerRef = getRef(target);
  if (innerRef !== undefined) {
    return follow(doc, innerRef, location, [...seen, ref]);
  }
  return target;
}

function expectBucket(ref: string, bucket: Bucket, location: string): void {
  if (!ref.startsWith(BUCKETS[bucket])) {
    throw new LoadError(
      `wrong ref bucket at ${location}: expected components.${bucket}, got ${ref}`,
    );
  }
}

function resolveItem<T>(doc: OpenAPIDocument, item: unknown, bucket: Bucket, location: string): T {
  const ref = getRef(item);
  if (ref !== undefined) {
    expectBucket(ref, bucket, location);
    return follow(doc, ref, location) as T;
  }
  return item as T;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export function resolveRefs(doc: OpenAPIDocument): OpenAPIDocument {
  const paths = doc.paths;
  if (!paths || typeof paths !== "object") return doc;

  const newPaths: Record<string, PathItem> = {};
  for (const [pathKey, raw] of Object.entries(paths)) {
    if (!isObject(raw)) {
      newPaths[pathKey] = raw as PathItem;
      continue;
    }
    const resolvedPathItem = resolveItem<PathItem>(doc, raw, "pathItems", `/paths/${pathKey}`);
    const newPathItem: PathItem = { ...resolvedPathItem };

    if (Array.isArray(resolvedPathItem.parameters)) {
      newPathItem.parameters = resolvedPathItem.parameters.map((p, i) =>
        resolveItem<Parameter>(doc, p, "parameters", `/paths/${pathKey}/parameters[${i}]`),
      );
    }

    for (const method of HTTP_METHODS) {
      const op = resolvedPathItem[method];
      if (!isObject(op)) continue;

      const newOp: Operation = { ...(op as Operation) };

      if (Array.isArray((op as Operation).parameters)) {
        newOp.parameters = (op as Operation).parameters!.map((p, i) =>
          resolveItem<Parameter>(
            doc,
            p,
            "parameters",
            `/paths/${pathKey}/${method}/parameters[${i}]`,
          ),
        );
      }

      const rb = (op as Operation).requestBody;
      if (rb && getRef(rb) !== undefined) {
        newOp.requestBody = resolveItem<RequestBody>(
          doc,
          rb,
          "requestBodies",
          `/paths/${pathKey}/${method}/requestBody`,
        );
      }

      const responses = (op as Operation).responses;
      if (responses && typeof responses === "object") {
        const newResponses: Record<string, Response> = {};
        for (const [code, r] of Object.entries(responses)) {
          newResponses[code] = resolveItem<Response>(
            doc,
            r,
            "responses",
            `/paths/${pathKey}/${method}/responses/${code}`,
          );
        }
        newOp.responses = newResponses;
      }

      newPathItem[method] = newOp;
    }

    newPaths[pathKey] = newPathItem;
  }

  return { ...doc, paths: newPaths };
}
