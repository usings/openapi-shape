import type { Empty, Operation } from "./endpoint"
import type { IsStringLiteral, IsUnion, LowercaseKeys } from "./utils"

/** Per-call input: the operation's parameters and body, and any other `RequestInit` field. */
export type MediaHeader<L extends string, V, Required extends boolean> = Required extends true
  ? Record<L, V>
  : Partial<Record<L, V>>

export type TypedHeaders<Op extends Operation> = ("headers" extends keyof Op
  ? Partial<LowercaseKeys<Op["headers"]>>
  : Empty) &
  Record<string, unknown> & { accept?: string }

/**
 * Declared headers keep their types, others are allowed; or a `Headers` or its entries, taken as
 * they are. Never required per call.
 */
export interface HeadersField<Op extends Operation> {
  headers?: Headers | Array<[string, string]> | TypedHeaders<Op>
}

/** Restore the caller's spelling only after checking its normalized header record. */
export type WithHeaders<Input, H> = object extends H
  ? Input
  : string extends keyof H
    ? Input
    : [Extract<H, Headers | readonly unknown[]>] extends [never]
      ? Input extends unknown
        ? Input extends { headers?: infer Allowed }
          ? LowercaseKeys<H> extends Exclude<Allowed, undefined>
            ? Omit<Input, "headers"> & { headers: H }
            : never
          : never
        : never
      : Input

export type HeaderArgs<A, H> = object extends H
  ? A
  : IsUnion<H> extends true
    ? A
    : { [K in keyof A]: WithHeaders<A[K], NoInfer<H>> }

/** Only a known, single default media can establish a structured body association. */
export type SingleMedia<M> =
  IsStringLiteral<M> extends true ? (IsUnion<M> extends false ? Extract<M, string> : never) : never
/** Read each union member before combining knowledge; string means opaque. */
type HeaderValue<H, K extends string, Fallback> = H extends unknown
  ? H extends undefined
    ? Fallback
    : H extends Headers | readonly unknown[]
      ? string
      : K extends keyof LowercaseKeys<H>
        ? LowercaseKeys<H>[K]
        : string extends keyof H
          ? string
          : Fallback
  : never

export type DefaultMedia<H> = SingleMedia<HeaderValue<H, "content-type", "application/json">>
export type DefaultAccept<H, V = HeaderValue<H, "accept", undefined>> = [V] extends [undefined]
  ? never
  : [SingleMedia<V>] extends [never]
    ? string
    : SingleMedia<V>

/**
 * Native response headers with declared names suggested; values remain unparsed and nullable. The
 * string intersection preserves literal suggestions while accepting any header name.
 */
export interface ResponseHeaders<Name extends string = never> extends Headers {
  get(name: Name | (string & Empty)): string | null
  has(name: Name | (string & Empty)): boolean
}
