export type Adapter<TOptions = unknown> = (request: {
  method: string;
  url: string;
  body: BodyInit | undefined;
  headers: Record<string, string>;
  options: TOptions | undefined;
}) => Promise<unknown>;

type EndpointDefinition = {
  params: unknown;
  query: unknown;
  body?: unknown;
  response: unknown;
};

type RequestField<TKey extends string, TValue> = TValue extends void
  ? { [Property in TKey]?: never }
  : undefined extends TValue
    ? { [Property in TKey]?: Exclude<TValue, undefined> }
    : {} extends TValue
      ? { [Property in TKey]?: TValue }
      : { [Property in TKey]: TValue };

type RequestOptions<T extends EndpointDefinition, TOptions> = RequestField<"params", T["params"]> &
  RequestField<"query", T["query"]> &
  RequestField<"body", T["body"]> & {
    headers?: Record<string, string>;
    options?: TOptions;
  };

type HasRequiredOptions<T extends EndpointDefinition> =
  {} extends RequestOptions<T, unknown> ? false : true;

export interface ClientOptions {
  baseURL?: string;
}

function splitEndpoint(endpoint: string): { method: string; path: string } {
  const space = endpoint.indexOf(" ");
  if (space === -1) return { method: endpoint, path: "" };
  return { method: endpoint.slice(0, space), path: endpoint.slice(space + 1) };
}

function replacePathParams(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/\{([^}/]+)\}/g, (_, name) => {
    if (!params || !(name in params)) {
      throw new Error(`Missing path param: ${name}`);
    }
    return encodeURIComponent(String(params[name]));
  });
}

function appendQuery(url: string, query: Record<string, unknown> | undefined): string {
  if (!query) return url;

  const searchParams = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) searchParams.append(name, String(item));
      }
      continue;
    }
    searchParams.set(name, String(value));
  }

  const queryString = searchParams.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function isPassthroughBody(body: unknown): body is BodyInit {
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return true;
  if (body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body)) return true;
  return false;
}

function serializeBody(body: unknown): {
  body: BodyInit | undefined;
  headers: Record<string, string>;
} {
  if (body === undefined) return { body: undefined, headers: {} };
  if (isPassthroughBody(body)) return { body, headers: {} };
  return { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
}

export function createClient<
  Endpoints extends { [K in keyof Endpoints]: EndpointDefinition },
  TOptions = unknown,
>(adapter: Adapter<TOptions>, options?: ClientOptions) {
  const baseURL = (options?.baseURL ?? "").replace(/\/+$/, "");

  return async <K extends keyof Endpoints & string>(
    endpoint: K,
    ...args: HasRequiredOptions<Endpoints[K]> extends true
      ? [options: RequestOptions<Endpoints[K], TOptions>]
      : [options?: RequestOptions<Endpoints[K], TOptions>]
  ): Promise<Endpoints[K]["response"]> => {
    const { method, path } = splitEndpoint(endpoint);

    const opts = (args[0] ?? {}) as Record<string, unknown>;
    const pathWithParams = replacePathParams(
      path,
      opts.params as Record<string, unknown> | undefined,
    );
    const url = appendQuery(pathWithParams, opts.query as Record<string, unknown> | undefined);

    const { body, headers: bodyHeaders } = serializeBody(opts.body);
    const headers = { ...bodyHeaders, ...(opts.headers as Record<string, string> | undefined) };

    const result = await adapter({
      method,
      url: baseURL + url,
      body,
      headers,
      options: opts.options as TOptions | undefined,
    });

    return result as Endpoints[K]["response"];
  };
}
