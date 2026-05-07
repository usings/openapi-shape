import type { OpenAPIDocument, PathItem, Parameter, RequestBody, Response } from "./openapi";
import { LoadError } from "../shared/errors";
import { isObject } from "../shared/object";
import { decodePointerSegment } from "../shared/pointer";
import { mapDocument } from "./walk";

const REF_BUCKETS = {
  pathItems: "#/components/pathItems/",
  parameters: "#/components/parameters/",
  requestBodies: "#/components/requestBodies/",
  responses: "#/components/responses/",
} as const;

type RefBucket = keyof typeof REF_BUCKETS;

interface BucketTypes {
  pathItems: PathItem;
  parameters: Parameter;
  requestBodies: RequestBody;
  responses: Response;
}

export function resolveRefs(doc: OpenAPIDocument): OpenAPIDocument {
  const resolver = new RefResolver(doc);
  return mapDocument(doc, {
    pathItem: (item, location) => resolver.resolve(item, "pathItems", location),
    parameter: (p, location) => resolver.resolve(p, "parameters", location),
    requestBody: (b, location) => resolver.resolve(b, "requestBodies", location),
    response: (r, location) => resolver.resolve(r, "responses", location),
  });
}

class RefResolver {
  constructor(private readonly doc: OpenAPIDocument) {}

  resolve<K extends RefBucket>(item: unknown, bucket: K, location: string): BucketTypes[K] {
    const ref = readRef(item);
    if (ref !== undefined) {
      if (!ref.startsWith(REF_BUCKETS[bucket])) {
        throw new LoadError(
          `wrong ref bucket at ${location}: expected components.${bucket}, got ${ref}`,
        );
      }
      return this.follow(ref, location) as BucketTypes[K];
    }
    return item as BucketTypes[K];
  }

  private follow(ref: string, location: string, seen: string[] = []): unknown {
    if (seen.includes(ref)) {
      throw new LoadError(`circular ref at ${location}: ${[...seen, ref].join(" → ")}`);
    }
    const target = this.lookup(ref);
    if (target == null) {
      throw new LoadError(`ref not found at ${location}: ${ref}`);
    }
    const innerRef = readRef(target);
    if (innerRef !== undefined) {
      return this.follow(innerRef, location, [...seen, ref]);
    }
    return target;
  }

  private lookup(ref: string): unknown {
    if (!ref.startsWith("#/")) return undefined;
    const segments = ref.slice(2).split("/").map(decodePointerSegment);
    let current: unknown = this.doc;
    for (const segment of segments) {
      if (!isObject(current)) return undefined;
      current = current[segment];
    }
    return current;
  }
}

function readRef(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const ref = (value as { $ref?: unknown }).$ref;
  return typeof ref === "string" ? ref : undefined;
}
