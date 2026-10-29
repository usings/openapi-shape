import type { StreamingEssence } from "../../shared/media"
import type { Empty, Endpoint, Essence, IsJson, MethodOf, Operation, OperationOf } from "./endpoint"

/** A `Response` for one declared status or range: `json()` resolves to its JSON content. */
export interface TypedResponse<Status extends number, Ok extends boolean, Json> extends Response {
  readonly status: Status
  readonly ok: Ok
  json(): Promise<Json>
}

/** Endpoints whose bodies result() can read to completion. */
export type ResultEndpoint<E> = {
  [K in Endpoint<E>]: [keyof OperationOf<E, K>["responses"]] extends [never]
    ? K
    : Uppercase<MethodOf<K>> extends "HEAD"
      ? K
      : [CompleteContent<OperationOf<E, K>, MethodOf<K>>] extends [never]
        ? never
        : K
}[Endpoint<E>]

export type CompleteContent<Op extends Operation, Method extends string> =
  Outcomes<Op, Method> extends infer O
    ? O extends [number, infer Shape]
      ? Shape extends { content: infer C }
        ? { [M in keyof C & string]: Essence<M> extends StreamingEssence ? never : M }[keyof C &
            string]
        : "empty"
      : never
    : never

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
export type SuccessStatus<E> = Successes<E>[Endpoint<E>]["status"]

export type AtStatus<R, S extends number> = R extends { status: infer Status extends number }
  ? S extends Status
    ? R
    : never
  : never

export type DataAt<E, S extends number> = {
  [P in Endpoint<E> as P]: Extract<AtStatus<Successes<E>[P], S>, { data: unknown }>["data"]
}

export type JsonAt<E, S extends number> = {
  [P in Endpoint<E> as P]: AtStatus<Successes<E>[P], S> extends {
    response: TypedResponse<number, boolean, infer J>
  }
    ? J
    : never
}

export type FiniteResult<E, K extends Endpoint<E>> =
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
export type Successes<E> = {
  [P in Endpoint<E> as P]: Extract<
    ResultOf<OperationOf<E, P>, MethodOf<P>>,
    { data: unknown; error?: undefined }
  >
}

export type Failures<E> = {
  [P in Endpoint<E> as P]: Exclude<ResultOf<OperationOf<E, P>, MethodOf<P>>, { error?: undefined }>
}

export type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export type ToNumber<S> = S extends number ? S : S extends `${infer N extends number}` ? N : never

/** Every status of a class, such as `"4"`: `400 | 401 | … | 499`. */
export type StatusIn<Class extends string> = ToNumber<`${Class}${Digit}${Digit}`>

/** The statuses a response key stands for: a code, or a range less the codes declared on their own. */
export type StatusesOf<K, R> = K extends `${infer Class}XX`
  ? Exclude<StatusIn<Class>, ToNumber<keyof R>>
  : ToNumber<K>

export type Declared<R> = StatusesOf<Exclude<keyof R, "default">, R>

export type OkOf<Status> = Status extends StatusIn<"2"> ? true : false

/** What a response to `Method` carries: nothing for `HEAD`, whatever the description declares. */
export type ShapeFor<Method extends string, Shape> =
  Uppercase<Method> extends "HEAD" ? Empty : Shape

/** Responses that have no content, whatever the description declares. */
export type NoContent = 204 | 205 | 304

/** Statuses and what they carry, those that have no content apart. */
export type StatusOutcome<Status, Shape> = [Status] extends [never] ? never : [Status, Shape]

export type SplitNoContent<Status, Shape> =
  | StatusOutcome<Exclude<Status, NoContent>, Shape>
  | StatusOutcome<Extract<Status, NoContent>, Empty>

/** A status the description does not declare: any content. */
export interface Undeclared {
  content: { "*/*": unknown }
}

/** Only declared representations can complete result() or yield stream items. */
export type Outcomes<Op extends Operation, Method extends string, R = Op["responses"]> =
  | {
      [K in Exclude<keyof R, "default">]: SplitNoContent<StatusesOf<K, R>, ShapeFor<Method, R[K]>>
    }[Exclude<keyof R, "default">]
  | ("default" extends keyof R
      ?
          | SplitNoContent<Exclude<StatusIn<"2">, Declared<R>>, ShapeFor<Method, R["default"]>>
          | SplitNoContent<
              Exclude<StatusIn<"3" | "4" | "5">, Declared<R>>,
              ShapeFor<Method, R["default"]>
            >
      : never)

export type DefaultShape<Method extends string, R> = ShapeFor<
  Method,
  "default" extends keyof R ? R["default"] : Undeclared
>

/** Fetch delivers undeclared successes too; their JSON cannot be asserted from the contract. */
export type FetchOutcomes<Op extends Operation, Method extends string> =
  | [0, Empty]
  | Outcomes<Op, Method>
  | SplitNoContent<
      Exclude<StatusIn<"2">, Declared<Op["responses"]>>,
      DefaultShape<Method, Op["responses"]>
    >
  | SplitNoContent<
      Exclude<StatusIn<"3" | "4" | "5">, Declared<Op["responses"]>>,
      DefaultShape<Method, Op["responses"]>
    >

/** One {@link TypedResponse} per status the operation may answer with. */
export type ResponseOf<E, K extends Endpoint<E>> =
  FetchOutcomes<OperationOf<E, K>, MethodOf<K>> extends infer O
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
export type ErrorBody<T> = unknown extends T
  ? NonNullable<unknown> | null
  : undefined extends T
    ? Exclude<T, undefined> | null
    : T

/**
 * What `json()` resolves to: the response's JSON content, `unknown` where it declares other
 * content, and nothing where it has none, since `json()` rejects.
 */
export type JsonOf<Shape> = Shape extends { content: infer Content }
  ? [Exclude<keyof Content & string, JsonMedia<Content>>] extends [never]
    ? Content[JsonMedia<Content>]
    : unknown
  : never

export type JsonMedia<Content> = {
  [M in keyof Content & string]: Essence<M> extends `${string}*${string}`
    ? never
    : IsJson<M> extends true
      ? M
      : never
}[keyof Content & string]

/**
 * Each media type's content as decoded: JSON as declared, other text as a string, others as a Blob;
 * a range as any media type in it.
 */
export type Decoded<Shape> = Shape extends { content: infer Content }
  ? {
      [M in keyof Content & string]: Essence<M> extends StreamingEssence
        ? never
        : DecodedAs<M, Content[M]>
    }[keyof Content & string]
  : undefined

export type DecodedAs<M extends string, T> =
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

export type TextOf<T> = T extends string ? T : string
