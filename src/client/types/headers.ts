import type { Empty, IsUnion, Only, Operation } from "./endpoint"

/** Per-call input: the operation's parameters and body, and any other `RequestInit` field. */
export type MediaHeader<L extends string, V, Required extends boolean> = Required extends true
  ? Record<L, V>
  : Partial<Record<L, V>>

export type TypedHeaders<Op extends Operation> = ("headers" extends keyof Op
  ? Partial<LowercaseHeaders<Op["headers"]>>
  : Empty) &
  Record<string, unknown> & { accept?: string }

/**
 * Declared headers keep their types, others are allowed; or a `Headers` or its entries, taken as
 * they are. Never required per call.
 */
export interface HeadersField<Op extends Operation> {
  headers?: Headers | Array<[string, string]> | TypedHeaders<Op>
}

/** HTTP field names are case-insensitive; retain literal values for media inference. */
export type LowercaseHeaders<H> = {
  [K in keyof H as K extends string ? Lowercase<K> : K]: H[K]
}

/** Restore the caller's spelling only after checking its normalized header record. */
export type WithHeaders<Input, H> = object extends H
  ? Input
  : string extends keyof H
    ? Input
    : [Extract<H, Headers | readonly unknown[]>] extends [never]
      ? Input extends unknown
        ? Input extends { headers?: infer Allowed }
          ? LowercaseHeaders<H> extends Exclude<Allowed, undefined>
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
export type SingleMedia<M> = string extends M ? never : Extract<Only<M>, string>
export type DefaultMedia<H, Normalized = LowercaseHeaders<H>> = [H] extends [undefined]
  ? "application/json"
  : undefined extends H
    ? never
    : H extends Headers | readonly unknown[]
      ? never
      : "content-type" extends keyof Normalized
        ? SingleMedia<Normalized["content-type"]>
        : string extends keyof H
          ? never
          : "application/json"
