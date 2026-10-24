import type { StreamMessage, StreamOptions } from "./stream"

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

/** Callable endpoints with a supported streaming success response. */
export type StreamEndpoint<E> = {
  [K in Endpoint<E>]: [StreamContent<OperationOf<E, K>, MethodOf<K>>] extends [never] ? never : K
}[Endpoint<E>]

/** Endpoints whose bodies result() can read to completion. */
export type ResultEndpoint<E> = Exclude<Endpoint<E>, StreamEndpoint<E>>

type StreamingEssence = "text/event-stream" | "application/jsonl" | "application/x-ndjson"

type StreamsIn<Shape> = Shape extends { content: infer Content }
  ? {
      // Keep media presence even when its schema allows no values (content is never).
      [M in keyof Content & string]: Essence<M> extends StreamingEssence
        ? { media: M; content: Content[M] }
        : never
    }[keyof Content & string]
  : never

// Avoid expanding status ranges for operations that have no streaming media at all.
type StreamContent<Op extends Operation, Method extends string> = [
  StreamsIn<Op["responses"][keyof Op["responses"]]>,
] extends [never]
  ? never
  : Outcomes<Op, Method> extends infer Outcome
    ? Outcome extends [infer Status extends number, infer Shape]
      ? [Extract<Status, StatusIn<"2">>] extends [never]
        ? never
        : StreamsIn<Shape>
      : never
    : never

/** Declared streaming response media, including its original spelling and parameters. */
export type StreamMedia<E, K extends StreamEndpoint<E>> = StreamContent<
  OperationOf<E, K>,
  MethodOf<K>
>["media"]

/** One parsed item of the selected streaming response media. */
export type EndpointStreamItem<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K> = StreamMedia<E, K>,
> = StreamItem<Extract<StreamContent<OperationOf<E, K>, MethodOf<K>>, { media: M }>>

type StreamItem<Media> = Media extends { media: infer M extends string; content: infer Content }
  ? Essence<M> extends "text/event-stream"
    ? MessageOf<Content>
    : Content extends ReadonlyArray<infer Item>
      ? Item
      : unknown
  : never

/** A parsed SSE event, narrowed by itemSchema; data remains wire text. */
export type EndpointMessage<E, K extends StreamEndpoint<E>> = EndpointStreamItem<
  E,
  K,
  EventMedia<StreamMedia<E, K>>
>
type EventMedia<M extends string> = M extends unknown
  ? Essence<M> extends "text/event-stream"
    ? M
    : never
  : never

type MessageOf<Content> =
  Content extends ReadonlyArray<infer Item> ? EventItem<Item> : StreamMessage
type EventItem<Item> = Item extends object
  ? StreamMessage & Pick<Item, Extract<keyof Item, keyof StreamMessage>>
  : StreamMessage

type Replayable<Call> = Call extends unknown
  ? {
      [P in keyof Call]: P extends "body"
        ? Exclude<Call[P], ReadableStream | AsyncIterable<Uint8Array>>
        : Call[P]
    }
  : never
type StreamInit<E, K extends StreamEndpoint<E>, M extends StreamMedia<E, K>> = Replayable<
  Init<OperationOf<E, K>, MethodOf<K>>
> & { accept?: M } & StreamSelection<E, K, M>
type StreamSelection<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K>,
> = M extends unknown
  ? ([Only<StreamMedia<E, K>>] extends [never] ? { accept: M } : { accept?: M }) &
      (Essence<M> extends "text/event-stream" ? Pick<StreamOptions, "retry"> : { retry?: never })
  : never

/** Stream arguments preserve required inputs, select a media type, and exclude one-shot bodies. */
// Keep the init tuple outside conditionals so accept can infer the selected media.
export type StreamArgs<
  E,
  K extends StreamEndpoint<E>,
  M extends StreamMedia<E, K> = StreamMedia<E, K>,
> =
  | ([K] extends [never] ? [init?: never] : never)
  | [init: StreamInit<E, K, M> & (IsUnion<K> extends true ? never : unknown)]
  | (IsUnion<K> extends true
      ? never
      : Empty extends StreamInit<E, K, M>
        ? [init?: undefined]
        : never)

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
export type EndpointArgs<E, K extends Endpoint<E>> = Args<K, Init<OperationOf<E, K>, MethodOf<K>>>
type Args<K, Input> = [K] extends [never]
  ? [init?: never]
  : IsUnion<K> extends true
    ? [init: never]
    : Empty extends Input
      ? [init?: Input]
      : [init: Input]

/**
 * The data of an endpoint's 2xx responses: what `result` gives as `data` once `error` is
 * `undefined`, for functions that pass calls on and return it.
 */
export type EndpointData<E, K extends ResultEndpoint<E>> = {
  [S in SuccessStatus<E>]: DataAt<E, S>[K]
}[SuccessStatus<E>]

/** The decoded result, discriminated by status and by the presence of an error. */
export type EndpointResult<E, K extends ResultEndpoint<E>> = FiniteResult<E, K>

// Index by status first, then endpoint. The result and EndpointData read the
// same data table, so generic returns need no comparison or intersection of
// response bodies. Filter absent statuses inside each endpoint entry: intersecting
// two large endpoint-key unions makes TypeScript expand their cross product.
type SuccessStatus<E> = Successes<E>[Endpoint<E>]["status"]
type AtStatus<R, S extends number> = R extends { status: infer Status extends number }
  ? S extends Status
    ? R
    : never
  : never
type DataAt<E, S extends number> = {
  [P in Endpoint<E> as P]: Extract<AtStatus<Successes<E>[P], S>, { data: unknown }>["data"]
}
type JsonAt<E, S extends number> = {
  [P in Endpoint<E> as P]: AtStatus<Successes<E>[P], S> extends {
    response: TypedResponse<number, boolean, infer J>
  }
    ? J
    : never
}
type FiniteResult<E, K extends Endpoint<E>> =
  | {
      [S in SuccessStatus<E>]: {
        [P in K]: [AtStatus<Successes<E>[P], S>] extends [never]
          ? never
          : {
              data: DataAt<E, S>[P]
              error?: undefined
              status: S
              response: TypedResponse<S, true, JsonAt<E, S>[P]>
            }
      }[K]
    }[SuccessStatus<E>]
  | Failures<E>[K]

// Remapped endpoint keys prevent TypeScript from substituting a generic call key
// into the conditional response calculation before error/status narrowing.
type Successes<E> = {
  [P in Endpoint<E> as P]: Extract<
    ResultOf<OperationOf<E, P>, MethodOf<P>>,
    { data: unknown; error?: undefined }
  >
}
type Failures<E> = {
  [P in Endpoint<E> as P]: Exclude<ResultOf<OperationOf<E, P>, MethodOf<P>>, { error?: undefined }>
}

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never

/** `{ params: P }` when declared and required, `{ params?: P }` when optional, else forbidden. */
type Field<Name extends "params" | "query", Op extends Operation> = Name extends keyof Op
  ? Empty extends Pick<Op, Name>
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

/**
 * What the client encodes for a media type; others take ready-made bodies. Text is sent as given, a
 * string, though `text/*` content may also be JSON.
 */
type BodyValue<Content, M extends keyof Content & string> =
  IsEncodable<M> extends true
    ?
        | (IsJson<M> extends true
            ? Content[M]
            : Essence<M> extends `text/${string}`
              ? TextOf<Content[M]>
              : FormValue<Content[M]>)
        | BodyLike
        | (Essence<M> extends "application/x-www-form-urlencoded" ? string : never)
    : BodyLike | string

/** Structured forms encode named fields; arrays and scalar schemas need a ready-made body. */
type FormValue<T> = unknown extends T
  ? Record<string, unknown>
  : T extends readonly unknown[]
    ? never
    : T extends object
      ? T
      : never

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

type ToNumber<S> = S extends number ? S : S extends `${infer N extends number}` ? N : never

/** Every status of a class, such as `"4"`: `400 | 401 | … | 499`. */
type StatusIn<Class extends string> = ToNumber<`${Class}${Digit}${Digit}`>

/** The statuses a response key stands for: a code, or a range less the codes declared on their own. */
type StatusesOf<K, R> = K extends `${infer Class}XX`
  ? Exclude<StatusIn<Class>, ToNumber<keyof R>>
  : ToNumber<K>

type Declared<R> = StatusesOf<Exclude<keyof R, "default">, R>

type SuccessKey<R> = Extract<keyof R, `2${string}` | StatusIn<"2">>

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
export type ResponseOf<E, K extends Endpoint<E>> =
  Outcomes<OperationOf<E, K>, MethodOf<K>> extends infer O
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
  ? [JsonMedia<Content>] extends [never]
    ? unknown
    : Content[JsonMedia<Content>]
  : never

type JsonMedia<Content> = {
  [M in keyof Content & string]: IsJson<M> extends true
    ? M
    : Essence<M> extends "text/*"
      ? M
      : never
}[keyof Content & string]

/**
 * Each media type's content as decoded: JSON as declared, other text as a string, others as a Blob;
 * a range as any media type in it.
 */
type Decoded<Shape> = Shape extends { content: infer Content }
  ? { [M in keyof Content & string]: DecodedAs<M, Content[M]> }[keyof Content & string]
  : undefined

type DecodedAs<M extends string, T> =
  Essence<M> extends "*/*"
    ? T | string | Blob
    : Essence<M> extends "application/*"
      ? T | Blob
      : IsJson<M> extends true
        ? T
        : Essence<M> extends "text/*"
          ? T | TextOf<T>
          : Essence<M> extends `text/${string}`
            ? TextOf<T>
            : Blob

type TextOf<T> = T extends string ? T : string
