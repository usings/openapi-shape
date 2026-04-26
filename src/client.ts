export type Adapter<TOptions = unknown> = (request: {
  method: string;
  url: string;
  body: BodyInit | undefined;
  headers: Record<string, string>;
  options: TOptions | undefined;
}) => Promise<unknown>;

type RouteDefinition = {
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

type RequestOptions<T extends RouteDefinition, TOptions> = RequestField<"params", T["params"]> &
  RequestField<"query", T["query"]> &
  RequestField<"body", T["body"]> & {
    headers?: Record<string, string>;
    options?: TOptions;
  };

type HasRequiredOptions<T extends RouteDefinition> =
  {} extends RequestOptions<T, unknown> ? false : true;

export interface ClientOptions {
  baseURL?: string;
}

function splitRoute(route: string): { method: string; path: string } {
  const space = route.indexOf(" ");
  if (space === -1) return { method: route, path: "" };
  return { method: route.slice(0, space), path: route.slice(space + 1) };
}

function replacePathParams(path: string, params: Record<string, unknown> | undefined): string {
  if (!params) return path;

  let url = path;
  for (const [name, value] of Object.entries(params)) {
    url = url.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
  }
  return url;
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

export function createClient<API extends { [K in keyof API]: RouteDefinition }, TOptions = unknown>(
  adapter: Adapter<TOptions>,
  options?: ClientOptions,
) {
  const baseURL = (options?.baseURL ?? "").replace(/\/+$/, "");

  return async <K extends keyof API & string>(
    route: K,
    ...args: HasRequiredOptions<API[K]> extends true
      ? [options: RequestOptions<API[K], TOptions>]
      : [options?: RequestOptions<API[K], TOptions>]
  ): Promise<API[K]["response"]> => {
    const { method, path } = splitRoute(route);

    const opts = (args[0] ?? {}) as Record<string, any>;
    const url = appendQuery(
      replacePathParams(path, opts.params as Record<string, unknown> | undefined),
      opts.query as Record<string, unknown> | undefined,
    );

    const { body, headers: bodyHeaders } = serializeBody(opts.body);
    const headers = { ...bodyHeaders, ...(opts.headers as Record<string, string> | undefined) };

    const result = await adapter({
      method,
      url: baseURL + url,
      body,
      headers,
      options: opts.options as TOptions | undefined,
    });

    return result as API[K]["response"];
  };
}
