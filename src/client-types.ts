// ----- Building blocks -----

type FetchBodyInit = typeof globalThis extends {
  fetch: (input: never, init?: infer Init) => unknown;
}
  ? Init extends { body?: infer B }
    ? NonNullable<B>
    : never
  : never;

type FallbackBodyInit =
  | string
  | ArrayBuffer
  | ArrayBufferView<ArrayBuffer>
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream<Uint8Array<ArrayBuffer>>;

export type BodyLike = [FetchBodyInit] extends [never] ? FallbackBodyInit : FetchBodyInit;

type NonNullish = NonNullable<unknown>;

// ----- Contracts -----

export interface EndpointDefinition {
  params: unknown;
  query: unknown;
  body?: unknown;
  headers?: unknown;
  response: unknown;
}

interface AdapterRequest<TOptions = unknown> {
  method: string;
  url: string;
  body: BodyLike | undefined;
  headers: Record<string, string>;
  options: TOptions | undefined;
}

export interface BodySerializerResult {
  body: BodyLike | undefined;
  headers?: Record<string, string>;
}

type QuerySerializerResult = string | { toString(): string };

// ----- Type-level call signature derivation -----

// `NonNullish extends TValue` means the field type is broad enough to accept
// any defined value, so callers should not be forced to pass the option.
type RequestField<TKey extends string, TValue> = TValue extends void
  ? Partial<Record<TKey, never>>
  : undefined extends TValue
    ? Partial<Record<TKey, Exclude<TValue, undefined>>>
    : NonNullish extends TValue
      ? Partial<Record<TKey, TValue>>
      : Record<TKey, TValue>;

type RequestBodyField<TValue> = TValue extends void
  ? { body?: never }
  : undefined extends TValue
    ? { body?: Exclude<TValue, undefined> | BodyLike }
    : NonNullish extends TValue
      ? { body?: TValue | BodyLike }
      : { body: TValue | BodyLike };

type HeadersField<TValue> = TValue extends void
  ? { headers?: Record<string, string> }
  : undefined extends TValue
    ? { headers?: Exclude<TValue, undefined> & Record<string, string> }
    : NonNullish extends TValue
      ? { headers?: TValue & Record<string, string> }
      : { headers: TValue & Record<string, string> };

type EndpointHeaders<T extends EndpointDefinition> = T extends { headers: infer H } ? H : void;

export type RequestOptions<T extends EndpointDefinition, TOptions> = RequestField<
  "params",
  T["params"]
> &
  RequestField<"query", T["query"]> &
  RequestBodyField<T["body"]> &
  HeadersField<EndpointHeaders<T>> & {
    options?: TOptions;
  };

export type HasRequiredOptions<T extends EndpointDefinition> =
  NonNullish extends RequestOptions<T, unknown> ? false : true;

type ResponseMapOf<T extends { response: unknown }> =
  T["response"] extends Record<string, unknown> ? T["response"] : never;

type ResponseStatusKey<T extends { response: unknown }> = Extract<
  keyof ResponseMapOf<T>,
  `${number}${string}` | "default"
>;

type SuccessKey<T extends { response: unknown }> = Extract<ResponseStatusKey<T>, `2${string}`>;

type OnlyDefaultKey<T extends { response: unknown }> =
  Exclude<keyof ResponseMapOf<T>, "default"> extends never
    ? Extract<keyof ResponseMapOf<T>, "default">
    : never;

export interface RuntimeRequestOptions<TOptions> {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  options?: TOptions;
}

// ----- Public types -----

export type Adapter<TOptions = unknown> = (request: AdapterRequest<TOptions>) => Promise<unknown>;

export type BodySerializer = (body: unknown) => BodySerializerResult;

export type QuerySerializer = (query: Record<string, unknown>) => QuerySerializerResult;

/**
 * Extract a response type by exact status key.
 *
 * `TStatus` selects a literal response-map status such as `"200"`, `"404"`, or
 * `"default"`. Missing status keys resolve to `unknown`.
 */
export type ResultOf<
  T extends { response: unknown },
  TStatus extends string = Extract<ResponseStatusKey<T>, string>,
> =
  ResponseMapOf<T> extends infer R extends Record<string, unknown>
    ? TStatus extends keyof R
      ? R[TStatus]
      : unknown
    : unknown;

/**
 * Extract the client return type for an endpoint definition.
 *
 * Returns the union of all `2xx` response entries. When no `2xx` response is
 * declared, falls back to `response["default"]` only if `default` is the sole
 * response key.
 */
export type SuccessOf<T extends { response: unknown }> =
  ResponseMapOf<T> extends infer R extends Record<string, unknown>
    ? SuccessKey<T> extends never
      ? [OnlyDefaultKey<T>] extends [never]
        ? unknown
        : OnlyDefaultKey<T> extends keyof R
          ? R[OnlyDefaultKey<T>]
          : unknown
      : R[SuccessKey<T>]
    : unknown;

export type Client<
  Endpoints extends { [K in keyof Endpoints]: EndpointDefinition },
  TOptions = unknown,
> = <K extends keyof Endpoints & string>(
  endpoint: K,
  ...args: HasRequiredOptions<Endpoints[K]> extends true
    ? [options: RequestOptions<Endpoints[K], TOptions>]
    : [options?: RequestOptions<Endpoints[K], TOptions>]
) => Promise<SuccessOf<Endpoints[K]>>;

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
