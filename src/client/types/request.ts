import type { Empty, Endpoint, Essence, IsJson, MethodOf, Operation, OperationOf } from "./endpoint"
import type { HeadersField, MediaHeader, WithHeaders, SingleMedia } from "./headers"
import type { IsUnion, LowercaseKeys, TextOf } from "./utils"

/** Ready-made request bodies, including async byte iterables adapted to Web streams. */
export type BodyLike =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | FormData
  | URLSearchParams
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>

export type Init<
  Op extends Operation,
  Method extends string,
  D extends string = "application/json",
  H = object,
> = Omit<RequestInit, "method" | "headers" | "body"> & {
  baseURL?: string | URL | undefined
} & Field<"params", Op> &
  Field<"query", Op> &
  HeadersField<Op> &
  // fetch cannot send a body with GET or HEAD.
  (Uppercase<Method> extends "GET" | "HEAD" ? { body?: never } : BodyField<Op, D, H>)

/**
 * What a call takes after its endpoint, for functions that pass calls on: the init argument,
 * required exactly when the operation requires something. A call names one endpoint: a union of
 * them would mix their inputs and responses.
 */
export type EndpointArgs<
  E,
  K extends Endpoint<E>,
  D extends string = "application/json",
  H = object,
> = Args<K, WithHeaders<Init<OperationOf<E, K>, MethodOf<K>, D, H>, NoInfer<H>>> &
  (object extends H ? unknown : [init?: { headers?: H }])

export type Args<K, Input> = [K] extends [never]
  ? [init?: never]
  : IsUnion<K> extends true
    ? [init: never]
    : Empty extends Input
      ? [init?: Input]
      : [init: Input]

/** `{ params: P }` when declared and required, `{ params?: P }` when optional, else forbidden. */
export type Field<Name extends "params" | "query", Op extends Operation> = Name extends keyof Op
  ? Pick<Op, Name>
  : Partial<Record<Name, never>>

type BodyField<Op extends Operation, D extends string, H = object> = "body" extends keyof Op
  ?
      | (Empty extends Pick<Op, "body"> ? { body?: undefined } : never)
      | BodyVariant<NonNullable<Op["body"]>>
      | ExplicitBody<NonNullable<Op["body"]>, H>
      | DefaultBody<NonNullable<Op["body"]>, D, H>
      | { body: BodyLike }
  : { body?: never }

/** Match a known client default without guessing parameter-specific declarations. */
type MatchingKeys<C, M extends string> = {
  [K in keyof C & string]: Essence<K> extends M ? K : never
}[keyof C & string]

type Unparameterized<C, M extends string, K = MatchingKeys<C, M>> =
  Extract<K, `${string};${string}`> extends never ? K : never

/** Parameterized declarations are selected exactly; ambiguous parameter matches stay conservative. */
type DefaultMediaKey<C, D extends string> = D extends keyof C
  ? D
  : MatchingKeys<C, Essence<D>> extends never
    ? MatchingKeys<
        C,
        `${Essence<D> extends `${infer Major}/${string}` ? Major : never}/*`
      > extends never
      ? Unparameterized<C, "*/*">
      : Unparameterized<C, `${Essence<D> extends `${infer Major}/${string}` ? Major : never}/*`>
    : Unparameterized<C, Essence<D>>

type ExplicitBody<C, H, N = LowercaseKeys<H>> = "content-type" extends keyof N
  ? SingleMedia<N["content-type"]> extends infer M extends string
    ? [M] extends [never]
      ? never
      : DefaultMediaKey<C, M> extends infer K
        ? [K] extends [never]
          ? never
          : K extends keyof C & string
            ? { headers: Record<"content-type", M>; body: BodyValue<C, K, M> }
            : never
        : never
    : never
  : never

type DefaultBody<
  C,
  D extends string,
  H = object,
  M = DefaultMediaKey<C, D>,
> = "content-type" extends keyof LowercaseKeys<H>
  ? never
  : [M] extends [never]
    ? never
    : M extends keyof C & string
      ? {
          body: BodyValue<C, M, D>
          headers?: { "content-type"?: never; "Content-Type"?: never; [Symbol.iterator]?: never }
        }
      : never

/** Structured inputs require an explicit media header associated with their body shape. */
type ConcreteMedia<M extends string> = M extends "*/*"
  ? `${string}/${string}`
  : M extends `${infer T}/*`
    ? `${T}/${string}`
    : M

export type BodyVariant<Content> =
  | {
      [M in keyof Content & string]: {
        headers: MediaHeader<"content-type", ConcreteMedia<M>, true>
        body: M extends `${string}*${string}` ? BodyLike : BodyValue<Content, M>
      }
    }[keyof Content & string]
  | {
      headers: MediaHeader<"content-type", keyof Content & string, true>
      body: IntersectFunctionParameters<
        { [M in keyof Content & string]: (value: BodyValue<Content, M>) => void }[keyof Content &
          string]
      >
    }

type IntersectFunctionParameters<F> = [F] extends [(value: infer V) => void] ? V : never

/**
 * What the client encodes for a media type; others take ready-made bodies. Text is sent as given, a
 * string, though `text/*` content may also be JSON.
 */
type BodyValue<Content, M extends keyof Content & string, A extends string = M> =
  IsEncodable<A> extends true
    ?
        | (IsJson<A> extends true
            ? Content[M]
            : Essence<A> extends `text/${string}`
              ? TextOf<Content[M]>
              : FormValue<Content[M]>)
        | BodyLike
        | (Essence<A> extends "application/x-www-form-urlencoded" ? string : never)
    : BodyLike | string

/** Structured forms encode named fields; arrays and scalar schemas need a ready-made body. */
type FormValue<T> = unknown extends T
  ? Record<string, unknown>
  : T extends readonly unknown[]
    ? never
    : T extends object
      ? T
      : never

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
