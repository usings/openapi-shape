export type BodyLike =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream<Uint8Array>;

export type QuerySerializerResult = string | { toString(): string };

export type AdapterRequest<TOptions = unknown> = {
  method: string;
  url: string;
  body: BodyLike | undefined;
  headers: Record<string, string>;
  options: TOptions | undefined;
};

export type Adapter<TOptions = unknown> = (request: AdapterRequest<TOptions>) => Promise<unknown>;

export type EndpointDefinition = {
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

type RequestBodyField<TValue> = TValue extends void
  ? { body?: never }
  : undefined extends TValue
    ? { body?: Exclude<TValue, undefined> | BodyLike }
    : {} extends TValue
      ? { body?: TValue | BodyLike }
      : { body: TValue | BodyLike };

export type RequestOptions<T extends EndpointDefinition, TOptions> = RequestField<
  "params",
  T["params"]
> &
  RequestField<"query", T["query"]> &
  RequestBodyField<T["body"]> & {
    headers?: Record<string, string>;
    options?: TOptions;
  };

type HasRequiredOptions<T extends EndpointDefinition> =
  {} extends RequestOptions<T, unknown> ? false : true;

export interface ClientOptions<TOptions = unknown> {
  /**
   * Prefix for relative endpoint paths. Trailing slashes are removed.
   * Absolute `http://` and `https://` endpoint paths bypass this value.
   */
  baseURL?: string;

  /**
   * Default headers for every request. Header names are lowercased.
   * Merge order is defaults, body-derived headers, then per-call headers.
   */
  headers?: Record<string, string>;

  /**
   * Default adapter-specific options. Plain objects are shallow-merged with
   * per-call options; other values are replaced by the per-call value.
   */
  options?: TOptions;

  /**
   * Custom body serializer. When set, it receives every defined body and
   * replaces the default string, passthrough, and JSON handling.
   */
  serializeBody?: BodySerializer;

  /**
   * Custom query serializer. The default skips `null`/`undefined`, keeps
   * falsy values, and serializes arrays as repeated keys.
   */
  serializeQuery?: QuerySerializer;
}

export interface BodySerializerResult {
  body: BodyLike | undefined;
  headers?: Record<string, string>;
}

export type BodySerializer = (body: unknown) => BodySerializerResult;

export type QuerySerializer = (query: Record<string, unknown>) => QuerySerializerResult;

export type Client<
  Endpoints extends { [K in keyof Endpoints]: EndpointDefinition },
  TOptions = unknown,
> = <K extends keyof Endpoints & string>(
  endpoint: K,
  ...args: HasRequiredOptions<Endpoints[K]> extends true
    ? [options: RequestOptions<Endpoints[K], TOptions>]
    : [options?: RequestOptions<Endpoints[K], TOptions>]
) => Promise<Endpoints[K]["response"]>;

type RuntimeRequestOptions<TOptions> = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  options?: TOptions;
};

function splitEndpoint(endpoint: string): { method: string; path: string } {
  const space = endpoint.indexOf(" ");
  if (space <= 0 || space === endpoint.length - 1) {
    throw new Error(`Invalid endpoint: ${endpoint}`);
  }
  return { method: endpoint.slice(0, space), path: endpoint.slice(space + 1) };
}

function replacePathParams(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/\{([^}/]+)\}/g, (_, name) => {
    if (!params || !Object.hasOwn(params, name) || params[name] == null) {
      throw new Error(`Missing path param: ${name}`);
    }
    return encodeURIComponent(String(params[name]));
  });
}

function defaultSerializeQuery(query: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) params.append(name, String(item));
      }
      continue;
    }
    params.set(name, String(value));
  }

  return params;
}

function appendQuery(
  url: string,
  query: Record<string, unknown> | undefined,
  serializeQuery: QuerySerializer | undefined,
): string {
  if (!query) return url;

  const serialized = serializeQuery ? serializeQuery(query) : defaultSerializeQuery(query);
  const queryString =
    typeof serialized === "string" ? serialized.replace(/^\?/, "") : serialized.toString();
  if (!queryString) return url;

  const hashIndex = url.indexOf("#");
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const last = base.slice(-1);
  const separator = !base.includes("?") ? "?" : last === "?" || last === "&" ? "" : "&";
  return `${base}${separator}${queryString}${hash}`;
}

function isPassthroughBody(body: unknown): body is BodyLike {
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return true;
  if (body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body)) return true;
  return false;
}

function buildBody(
  body: unknown,
  serializer: BodySerializer | undefined,
): {
  body: BodyLike | undefined;
  headers: Record<string, string>;
} {
  if (body === undefined) return { body: undefined, headers: {} };

  if (serializer) {
    const result = serializer(body);
    return { body: result.body, headers: result.headers ?? {} };
  }

  if (typeof body === "string") return { body, headers: { "content-type": "text/plain" } };
  if (isPassthroughBody(body)) return { body, headers: {} };

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch (error) {
    throw new Error("Failed to serialize request body as JSON", { cause: error });
  }
  if (serialized === undefined) {
    throw new Error("Request body cannot be serialized as JSON");
  }
  return { body: serialized, headers: { "content-type": "application/json" } };
}

function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const normalizedName = name.trim().toLowerCase();
      if (!normalizedName) continue;
      headers[normalizedName] = value;
    }
  }
  return headers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function mergeAdapterOptions<TOptions>(
  defaults: TOptions | undefined,
  overrides: TOptions | undefined,
): TOptions | undefined {
  if (defaults === undefined) return overrides;
  if (overrides === undefined) return defaults;
  if (isPlainObject(defaults) && isPlainObject(overrides)) {
    return { ...defaults, ...overrides } as TOptions;
  }
  return overrides;
}

export function createClient<
  Endpoints extends { [K in keyof Endpoints]: EndpointDefinition },
  TOptions = unknown,
>(adapter: Adapter<TOptions>, options?: ClientOptions<TOptions>): Client<Endpoints, TOptions> {
  const baseURL = (options?.baseURL ?? "").replace(/\/+$/, "");
  const defaultHeaders = options?.headers;
  const defaultAdapterOptions = options?.options;
  const serializeBodyOption = options?.serializeBody;
  const serializeQueryOption = options?.serializeQuery;

  const client = async <K extends keyof Endpoints & string>(
    endpoint: K,
    ...args: HasRequiredOptions<Endpoints[K]> extends true
      ? [options: RequestOptions<Endpoints[K], TOptions>]
      : [options?: RequestOptions<Endpoints[K], TOptions>]
  ): Promise<Endpoints[K]["response"]> => {
    const { method, path } = splitEndpoint(endpoint);
    const opts = (args[0] ?? {}) as RuntimeRequestOptions<TOptions>;

    const pathWithParams = replacePathParams(path, opts.params);
    const url = appendQuery(pathWithParams, opts.query, serializeQueryOption);
    const { body, headers: bodyHeaders } = buildBody(opts.body, serializeBodyOption);
    const adapterOptions = mergeAdapterOptions(defaultAdapterOptions, opts.options);

    const result = await adapter({
      method,
      url: /^https?:\/\//i.test(url) ? url : baseURL + url,
      body,
      headers: mergeHeaders(defaultHeaders, bodyHeaders, opts.headers),
      options: adapterOptions,
    });

    return result as Endpoints[K]["response"];
  };

  return client;
}
