/** A `Response` for one declared status or range: `json()` resolves to its JSON content. */
export interface TypedResponse<Status extends number, Ok extends boolean, Json> extends Response {
  readonly status: Status
  readonly ok: Ok
  json(): Promise<Json>
}

/** Ready-made request bodies: what `fetch` sends as it is, and Node.js streams. */
export type BodyLike =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | FormData
  | URLSearchParams
  | ReadableStream
  | AsyncIterable<Uint8Array>

/** The empty object type: `Empty extends T` holds when every property of `T` is optional. */
type Empty = Record<never, never>

/** The shape of one entry of a generated `Endpoints` interface. */
interface Operation {
  params?: object
  query?: unknown
  headers?: object
  cookies?: object
  /** Media type → body type. */
  body?: object
  /** Status → `{ headers?, content? }`, its content by media type. */
  responses: object
}

export type OperationOf<Endpoints, K extends keyof Endpoints> = Endpoints[K] extends Operation
  ? Endpoints[K]
  : never

/** An endpoint's method; any method for an endpoint typed only as `string`. */
export type MethodOf<K extends string> = K extends `${infer Method} ${string}` ? Method : string

/**
 * The endpoints of `Endpoints` a client calls, such as `"GET /pets"`: every key but those whose
 * method `fetch` refuses (`CONNECT`, `TRACE`, `TRACK`).
 */
export type Endpoint<Endpoints> = Callable<keyof Endpoints & string>
type Callable<K> = K extends `${infer Method} ${string}`
  ? Uppercase<Method> extends "CONNECT" | "TRACE" | "TRACK"
    ? never
    : K
  : K

/** Per-call input: the operation's parameters and body, and any other `RequestInit` field. */
type Init<Op extends Operation, Method extends string> = Omit<
  RequestInit,
  "method" | "headers" | "body"
> &
  Field<"params", Op> &
  Field<"query", Op> &
  HeadersField<Op> &
  // fetch cannot send a body with GET or HEAD.
  (Uppercase<Method> extends "GET" | "HEAD" ? { body?: never; contentType?: never } : BodyField<Op>)

/**
 * What a call takes after its endpoint, for functions that pass calls on: the init argument,
 * required exactly when the operation requires something. A call names one endpoint: a union of
 * them would mix their inputs and responses.
 */
export type EndpointArgs<Endpoints, K extends Endpoint<Endpoints>> =
  // An unknown endpoint intersects to never; report it on the endpoint, not init.
  [K] extends [never]
    ? [init?: never]
    : IsUnion<K> extends true
      ? [init: never]
      : Empty extends Init<OperationOf<Endpoints, K>, MethodOf<K>>
        ? [init?: Init<OperationOf<Endpoints, K>, MethodOf<K>>]
        : [init: Init<OperationOf<Endpoints, K>, MethodOf<K>>]

/**
 * The data of an endpoint's 2xx responses: what `result` gives as `data` once `error` is
 * `undefined`, for functions that pass calls on and return it.
 */
export type EndpointData<Endpoints, K extends Endpoint<Endpoints>> = [OpenKeys<Endpoints>] extends [
  never,
]
  ? { [S in SuccessStatus<Endpoints>]: DataAt<Endpoints, S>[K] }[SuccessStatus<Endpoints>]
  : OpenData<Endpoints, K>[K]

// Open maps need the called key to distinguish HEAD from other methods.
type OpenData<Endpoints, K extends Endpoint<Endpoints>> = {
  [P in Endpoint<Endpoints> as P]: Extract<
    CallResult<Endpoints, P, K>,
    { error?: undefined }
  >["data"]
}

/**
 * What `result` resolves to: the call's results, its successes and its failures apart, so that
 * `error === undefined` narrows `data` to {@link EndpointData} also while the endpoint is a type
 * parameter.
 */
export type EndpointResult<Endpoints, K extends Endpoint<Endpoints>> = [
  OpenKeys<Endpoints>,
] extends [never]
  ? FiniteResult<Endpoints, K>
  :
      | Extract<Successes<Endpoints, K>[K], { data: EndpointData<Endpoints, K>; error?: undefined }>
      | Failures<Endpoints, K>[K]

// Index by status first, then endpoint. The result and EndpointData read the
// same data table, so generic returns need no comparison or intersection of
// response bodies. Filter absent statuses inside each endpoint entry: intersecting
// two large endpoint-key unions makes TypeScript expand their cross product.
// `never` shares the finite map across calls; open maps still use the called key.
type SuccessStatus<E> = Successes<E, never>[Endpoint<E>]["status"]
type AtStatus<R, S extends number> = R extends { status: infer Status extends number }
  ? S extends Status
    ? R
    : never
  : never
type DataAt<E, S extends number> = {
  [P in Endpoint<E> as P]: Extract<AtStatus<Successes<E, never>[P], S>, { data: unknown }>["data"]
}
type JsonAt<E, S extends number> = {
  [P in Endpoint<E> as P]: AtStatus<Successes<E, never>[P], S> extends {
    response: TypedResponse<number, boolean, infer J>
  }
    ? J
    : never
}
type FiniteResult<E, K extends Endpoint<E>> =
  | {
      [S in SuccessStatus<E>]: {
        [P in K]: [AtStatus<Successes<E, never>[P], S>] extends [never]
          ? never
          : {
              data: DataAt<E, S>[P]
              error?: undefined
              status: S
              response: TypedResponse<S, true, JsonAt<E, S>[P]>
            }
      }[K]
    }[SuccessStatus<E>]
  | Failures<E, never>[K]

// Mapped over every endpoint with remapped keys (`as`), so that TypeScript does
// not substitute a type parameter K into `ResultOf`, which `error` could not
// narrow: K picks from concrete results instead. Over `Endpoint`, K's
// constraint, so that TypeScript sees K index them.
// A failure with error: never also fits error?: undefined, but has no data.
type Successes<Endpoints, K extends Endpoint<Endpoints>> = {
  [P in Endpoint<Endpoints> as P]: Extract<
    CallResult<Endpoints, P, K>,
    { data: unknown; error?: undefined }
  >
}

type Failures<Endpoints, K extends Endpoint<Endpoints>> = {
  [P in Endpoint<Endpoints> as P]: Exclude<CallResult<Endpoints, P, K>, { error?: undefined }>
}

/**
 * The results of a call to endpoint `P`. An index or template key, which an empty object fills,
 * stands for many endpoints: its results are those of the endpoint the call names, `K`, as
 * `ResultOf` gives a concrete call.
 */
type CallResult<Endpoints, P, K> = ResultOf<
  OperationOf<Endpoints, CallKey<P, K> & keyof Endpoints>,
  MethodOf<CallKey<P, K> & string>
>

/** Index and template endpoints need the called key to determine their results. */
type OpenKeys<Endpoints> = {
  [P in Endpoint<Endpoints>]: Empty extends Record<P, 1> ? P : never
}[Endpoint<Endpoints>]

type CallKey<P, K> = Empty extends Record<P & string, 1> ? K : P

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never

/** `{ params: P }` when declared and required, `{ params?: P }` when optional, else forbidden. */
type Field<Name extends "params" | "query", Op extends Operation> = Name extends keyof Op
  ? Empty extends Pick<Op, Name>
    ? Partial<Record<Name, Op[Name]>>
    : Empty extends Op[Name]
      ? Partial<Record<Name, Op[Name]>>
      : Record<Name, Op[Name]>
  : Partial<Record<Name, never>>

/**
 * Declared headers keep their types, others are allowed; or a `Headers` or its entries, taken as
 * they are. Never required per call.
 */
interface HeadersField<Op extends Operation> {
  headers?:
    | Headers
    | Array<[string, string]>
    | (("headers" extends keyof Op ? Partial<Op["headers"]> : Empty) & Record<string, unknown>)
}

type BodyField<Op extends Operation> = "body" extends keyof Op
  ? Empty extends Pick<Op, "body">
    ?
        | BodyVariant<NonNullable<Op["body"]>, DefaultMediaType<NonNullable<Op["body"]>>>
        | { body?: undefined; contentType?: undefined }
    : BodyVariant<NonNullable<Op["body"]>, DefaultMediaType<NonNullable<Op["body"]>>>
  : { body?: never; contentType?: never }

/**
 * The media type sent when the call names none: the declared `application/json` one, parameters and
 * all, where one alone is; else the only one declared. The generator writes it into the contract by
 * the same rule (`defaultMediaType`).
 */
type DefaultMediaType<Content, M extends string = keyof Content & string> = [
  Only<ApplicationJson<M>>,
] extends [never]
  ? Only<M>
  : Only<ApplicationJson<M>>

type ApplicationJson<M extends string> = M extends unknown
  ? Essence<M> extends "application/json"
    ? M
    : never
  : never

/** `M` when it is a single type, else `never`. */
type Only<M, All = M> = M extends unknown ? ([All] extends [M] ? M : never) : never

/** One variant per declared media type; `contentType` may be omitted for the default. */
type BodyVariant<Content, Default> = {
  [M in keyof Content & string]: [M] extends [Default]
    ? { contentType?: M; body: BodyValue<Content, M> }
    : { contentType: M; body: BodyValue<Content, M> }
}[keyof Content & string]

/** What the client encodes for a media type; others take ready-made bodies. */
type BodyValue<Content, M extends keyof Content & string> =
  IsEncodable<M> extends true
    ?
        | Content[M]
        | BodyLike
        | (Essence<M> extends "application/x-www-form-urlencoded" ? string : never)
    : BodyLike | string

type Essence<M extends string> = Lowercase<M extends `${infer E};${string}` ? Trim<E> : Trim<M>>

/** Without the spaces and tabs around it (RFC 9110, OWS), as the client's run time trims them. */
type Trim<S extends string> = S extends ` ${infer T}` | `\t${infer T}`
  ? Trim<T>
  : S extends `${infer T} ` | `${infer T}\t`
    ? Trim<T>
    : S

/** JSON, and the wildcards that take it. */
type IsJson<M extends string> =
  Essence<M> extends `${string}/json` | `${string}+json` | "*/*" | "application/*" ? true : false

/** Media types the client encodes from a value: JSON, form, multipart, and text but event streams. */
type IsEncodable<M extends string> =
  IsJson<M> extends true
    ? true
    : Essence<M> extends "application/x-www-form-urlencoded" | "multipart/form-data"
      ? true
      : Essence<M> extends `text/${infer Subtype}`
        ? Subtype extends "event-stream"
          ? false
          : true
        : false

type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

type ToNumber<S> = S extends `${infer N extends number}` ? N : never

/** Every status of a class, such as `"4"`: `400 | 401 | … | 499`. */
type StatusIn<Class extends string> = ToNumber<`${Class}${Digit}${Digit}`>

/** The statuses a response key stands for: a code, or a range less the codes declared on their own. */
type StatusesOf<K, R> = K extends `${infer Class}XX`
  ? Exclude<StatusIn<Class>, ToNumber<keyof R>>
  : ToNumber<K>

type Declared<R> = StatusesOf<Exclude<keyof R, "default">, R>

type SuccessKey<R> = Extract<keyof R, `2${string}`>

type OkOf<Status> = Status extends StatusIn<"2"> ? true : false

/** What a response to `Method` carries: nothing for `HEAD`, whatever the description declares. */
type ShapeFor<Method extends string, Shape> = Uppercase<Method> extends "HEAD" ? Empty : Shape

/** Responses that have no content, whatever the description declares. */
type NoContent = 204 | 205 | 304

/** Statuses and what they carry, those that have no content apart. */
type SplitNoContent<Status, Shape> =
  | [Exclude<Status, NoContent>, Shape]
  | [Extract<Status, NoContent>, Empty]

/** A status the description does not declare: any content. */
interface Undeclared {
  content: { "*/*": unknown }
}

/**
 * Each status an operation may answer with, and what its response carries: one entry per declared
 * status or range. A declared 2xx status is the only success; `default` stands for every other
 * status, 2xx ones too when no 2xx is declared. Without it, an undeclared 3xx, 4xx, or 5xx status
 * may carry anything, and so may a 2xx status when no success is declared at all.
 */
type Outcomes<Op extends Operation, Method extends string, R = Op["responses"]> =
  | {
      [K in Exclude<keyof R, "default">]: SplitNoContent<StatusesOf<K, R>, ShapeFor<Method, R[K]>>
    }[Exclude<keyof R, "default">]
  | SplitNoContent<Exclude<StatusIn<"3" | "4" | "5">, Declared<R>>, DefaultShape<Method, R>>
  | ([SuccessKey<R>] extends [never]
      ? SplitNoContent<Exclude<StatusIn<"2">, Declared<R>>, DefaultShape<Method, R>>
      : never)

type DefaultShape<Method extends string, R> = ShapeFor<
  Method,
  "default" extends keyof R ? R["default"] : Undeclared
>

/** One {@link TypedResponse} per status the operation may answer with. */
export type ResponseOf<Op extends Operation, Method extends string> =
  Outcomes<Op, Method> extends infer O
    ? O extends [infer Status extends number, infer Shape]
      ? [Status] extends [never]
        ? never
        : TypedResponse<Status, OkOf<Status>, JsonOf<Shape>>
      : never
    : never

/**
 * One result per status the operation may answer with: its body, decoded, as `data` for a success
 * and `error` for a failure, never both. A failure's `error` is never `undefined`, so `error ===
 * undefined` tells a success, also once destructured. `status` is the response's, at the top so
 * that it narrows them too: TypeScript does not narrow a union through `response.status`.
 */
export type ResultOf<Op extends Operation, Method extends string> =
  Outcomes<Op, Method> extends infer O
    ? O extends [infer Status extends number, infer Shape]
      ? [Status] extends [never]
        ? never
        : OkOf<Status> extends true
          ? {
              data: Decoded<Shape>
              error?: undefined
              status: Status
              response: TypedResponse<Status, true, JsonOf<Shape>>
            }
          : {
              data?: undefined
              error: ErrorBody<Decoded<Shape>>
              status: Status
              response: TypedResponse<Status, false, JsonOf<Shape>>
            }
      : never
    : never

/** A failure's body: `null` where there is none. */
type ErrorBody<T> = unknown extends T
  ? NonNullable<unknown> | null
  : undefined extends T
    ? Exclude<T, undefined> | null
    : T

/**
 * What `json()` resolves to: the response's JSON content, `unknown` where it declares other
 * content, and nothing where it has none, since `json()` rejects.
 */
type JsonOf<Shape> = Shape extends { content: infer Content }
  ? [JsonContent<Content>] extends [never]
    ? unknown
    : JsonContent<Content>
  : never

/** Raw bytes are never JSON, though a wildcard media type may declare them. */
type JsonContent<Content> = {
  [M in keyof Content & string]: IsJson<M> extends true ? Exclude<Content[M], Blob> : never
}[keyof Content & string]

/** Each media type's content as decoded: JSON as declared, `text/*` as a string, others as a Blob. */
type Decoded<Shape> = Shape extends { content: infer Content }
  ? { [M in keyof Content & string]: DecodedAs<M, Content[M]> }[keyof Content & string]
  : undefined

type DecodedAs<M extends string, T> =
  IsJson<M> extends true ? JsonValue<M, T> : Essence<M> extends `text/${string}` ? TextOf<T> : Blob

/**
 * JSON is parsed, never a Blob, whatever the schema says; under a wildcard, raw bytes may come
 * labelled as anything, and are decoded so: `unknown`.
 */
type JsonValue<M extends string, T> = [Extract<T, Blob>] extends [never]
  ? T
  : Essence<M> extends "*/*" | "application/*"
    ? unknown
    : [Exclude<T, Blob>] extends [never]
      ? unknown
      : Exclude<T, Blob>

type TextOf<T> = T extends string ? T : string
