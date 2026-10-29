import type { UnionToIntersection } from "../type-utils"
import type {
  Empty,
  Endpoint,
  Essence,
  IsJson,
  IsUnion,
  MethodOf,
  Operation,
  OperationOf,
} from "./endpoint"
import type { HeadersField, MediaHeader, WithHeaders } from "./headers"
import type { TextOf } from "./response"

/** Ready-made request bodies, including async byte iterables adapted to Web streams. */
export type BodyLike =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | FormData
  | URLSearchParams
  | ReadableStream
  | AsyncIterable<Uint8Array>

export type Init<
  Op extends Operation,
  Method extends string,
  D extends string = "application/json",
> = Omit<RequestInit, "method" | "headers" | "body"> & {
  baseURL?: string | URL | undefined
} & Field<"params", Op> &
  Field<"query", Op> &
  HeadersField<Op> &
  // fetch cannot send a body with GET or HEAD.
  (Uppercase<Method> extends "GET" | "HEAD" ? { body?: never } : BodyField<Op, D>)

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
> = Args<K, WithHeaders<Init<OperationOf<E, K>, MethodOf<K>, D>, NoInfer<H>>> &
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
  ? Empty extends Pick<Op, Name>
    ? Partial<Record<Name, Op[Name]>>
    : Record<Name, Op[Name]>
  : Partial<Record<Name, never>>

export type BodyField<Op extends Operation, D extends string> = "body" extends keyof Op
  ?
      | (Empty extends Pick<Op, "body"> ? { body?: undefined } : never)
      | BodyVariant<NonNullable<Op["body"]>>
      | DefaultBody<NonNullable<Op["body"]>, D>
      | { body: BodyLike }
  : { body?: never }

/** Match a known client default without guessing parameter-specific declarations. */
export type DefaultMediaKey<C, D extends string> = D extends keyof C
  ? D
  : Extract<keyof C & string, `${Essence<D>};${string}`> extends never
    ? Essence<D> extends keyof C
      ? Essence<D>
      : D extends `${infer Major}/${string}`
        ? `${Lowercase<Major>}/*` extends keyof C
          ? `${Lowercase<Major>}/*`
          : "*/*" extends keyof C
            ? "*/*"
            : never
        : never
    : never

export type DefaultBody<C, D extends string, M = DefaultMediaKey<C, D>> = [M] extends [never]
  ? never
  : M extends keyof C & string
    ? {
        body: BodyValue<C, M>
        headers?: { "content-type"?: never; "Content-Type"?: never; [Symbol.iterator]?: never }
      }
    : never

/** Structured inputs require an explicit media header associated with their body shape. */
export type ConcreteMedia<M extends string> = M extends "*/*"
  ? `${string}/${string}`
  : M extends `${infer T}/*`
    ? `${T}/${string}`
    : M

export type BodyVariant<Content> =
  | {
      [M in keyof Content & string]: {
        headers: MediaHeader<"content-type", ConcreteMedia<M>, true>
        body: M extends `${string}*${string}`
          ? BodyValue<Content, M> & CompatibleBodies<Content, M>
          : BodyValue<Content, M>
      }
    }[keyof Content & string]
  | {
      headers: MediaHeader<"content-type", keyof Content & string, true>
      body: Intersection<
        { [M in keyof Content & string]: (value: BodyValue<Content, M>) => void }[keyof Content &
          string]
      >
    }

/** Intersect properties, preserving each body's own union of native alternatives. */
export type CompatibleBodies<C, M extends string> =
  UnionToIntersection<
    {
      [K in keyof C & string]: K extends ConcreteMedia<M>
        ? { body: BodyValue<C, K> }
        : { body: unknown }
    }[keyof C & string]
  > extends { body: infer B }
    ? B
    : unknown

export type Intersection<F> = [F] extends [(value: infer V) => void] ? V : never

/**
 * What the client encodes for a media type; others take ready-made bodies. Text is sent as given, a
 * string, though `text/*` content may also be JSON.
 */
export type BodyValue<Content, M extends keyof Content & string> =
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
export type FormValue<T> = unknown extends T
  ? Record<string, unknown>
  : T extends readonly unknown[]
    ? never
    : T extends object
      ? T
      : never

/** Media types the client encodes from a value: JSON, form, multipart, and text but event streams. */
export type IsEncodable<M extends string> =
  IsJson<M> extends true
    ? true
    : Essence<M> extends "application/x-www-form-urlencoded" | "multipart/form-data"
      ? true
      : Essence<M> extends `text/${infer Subtype}`
        ? Subtype extends "event-stream"
          ? false
          : true
        : false
