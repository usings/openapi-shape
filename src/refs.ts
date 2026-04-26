function lookup(openapi: any, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: any = openapi;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function follow(openapi: any, ref: string, location: string, seen: string[] = []): unknown {
  if (seen.includes(ref)) {
    const chain = [...seen, ref].join(" → ");
    throw new Error(`circular ref at ${location}: ${chain}`);
  }
  const target = lookup(openapi, ref);
  if (target == null) {
    throw new Error(`ref not found at ${location}: ${ref}`);
  }
  if (typeof target === "object" && target !== null && "$ref" in target) {
    return follow(openapi, (target as any).$ref, location, [...seen, ref]);
  }
  return target;
}

const BUCKETS = {
  pathItems: "#/components/pathItems/",
  parameters: "#/components/parameters/",
  requestBodies: "#/components/requestBodies/",
  responses: "#/components/responses/",
} as const;

function expectBucket(ref: string, bucket: keyof typeof BUCKETS, location: string): void {
  if (!ref.startsWith(BUCKETS[bucket])) {
    throw new Error(`wrong ref bucket at ${location}: expected components.${bucket}, got ${ref}`);
  }
}

function resolveItem<T>(
  openapi: any,
  item: any,
  bucket: keyof typeof BUCKETS,
  location: string,
): T {
  if (item && typeof item === "object" && "$ref" in item) {
    expectBucket(item.$ref, bucket, location);
    return follow(openapi, item.$ref, location) as T;
  }
  return item;
}

export function resolveRefs(openapi: any): any {
  const paths = openapi?.paths;
  if (!paths || typeof paths !== "object") return openapi;

  const newPaths: Record<string, any> = {};
  for (const [pathKey, pathItem] of Object.entries<any>(paths)) {
    if (!pathItem || typeof pathItem !== "object") {
      newPaths[pathKey] = pathItem;
      continue;
    }
    const resolvedPathItem = resolveItem<Record<string, any>>(
      openapi,
      pathItem,
      "pathItems",
      `/paths/${pathKey}`,
    );
    const newPathItem: Record<string, any> = { ...resolvedPathItem };

    if (Array.isArray(resolvedPathItem.parameters)) {
      newPathItem.parameters = resolvedPathItem.parameters.map((parameter: any, index: number) =>
        resolveItem(openapi, parameter, "parameters", `/paths/${pathKey}/parameters[${index}]`),
      );
    }

    for (const [method, operation] of Object.entries<any>(resolvedPathItem)) {
      if (method === "parameters" || !operation || typeof operation !== "object") continue;
      const newOperation: Record<string, any> = { ...operation };

      if (Array.isArray(operation.parameters)) {
        newOperation.parameters = operation.parameters.map((parameter: any, index: number) =>
          resolveItem(
            openapi,
            parameter,
            "parameters",
            `/paths/${pathKey}/${method}/parameters[${index}]`,
          ),
        );
      }

      if (
        operation.requestBody &&
        typeof operation.requestBody === "object" &&
        "$ref" in operation.requestBody
      ) {
        newOperation.requestBody = resolveItem(
          openapi,
          operation.requestBody,
          "requestBodies",
          `/paths/${pathKey}/${method}/requestBody`,
        );
      }

      if (operation.responses && typeof operation.responses === "object") {
        const newResponses: Record<string, any> = {};
        for (const [statusCode, response] of Object.entries<any>(operation.responses)) {
          newResponses[statusCode] = resolveItem(
            openapi,
            response,
            "responses",
            `/paths/${pathKey}/${method}/responses/${statusCode}`,
          );
        }
        newOperation.responses = newResponses;
      }

      newPathItem[method] = newOperation;
    }
    newPaths[pathKey] = newPathItem;
  }

  return { ...openapi, paths: newPaths };
}
