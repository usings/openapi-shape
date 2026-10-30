type IsAny<T> = 0 extends 1 & T ? true : false
type IsNever<T> = [T] extends [never] ? true : false

type IsEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? (<G>() => G extends (A & G) | G ? 1 : 2) extends <G>() => G extends (B & G) | G ? 1 : 2
      ? true
      : false
    : false
  : false

/** A definite boolean, including for never and overlapping union members. */
export type IsUnion<T, U = T> = (
  IsNever<T> extends true
    ? false
    : T extends unknown
      ? IsEqual<U, T> extends true
        ? false
        : true
      : never
) extends infer Result
  ? boolean extends Result
    ? true
    : Result
  : never

type Primitive = null | undefined | string | number | boolean | symbol | bigint
type KeysOfUnion<T> = T extends unknown ? keyof T : never
type UnwrapBrand<T> = T extends Primitive
  ? T extends (infer U) & Pick<T, Exclude<keyof T, KeysOfUnion<Primitive>>>
    ? U
    : T
  : T
type NonNullish = Record<never, never>

type CollapseLiterals<T> = NonNullish extends T ? T : T extends (infer U) & {} ? U : T
type LiteralString<S> = S extends string
  ? NonNullish extends Record<S, never>
    ? false
    : true
  : false

/** Finite string literals; a literal union is allowed, an infinite pattern is not. */
export type IsStringLiteral<S> =
  IsAny<S> extends true
    ? false
    : IsNever<S> extends true
      ? false
      : LiteralString<CollapseLiterals<UnwrapBrand<S>>>

/** Shallow key normalization, preserving optional/readonly modifiers and non-string keys. */
export type LowercaseKeys<T> = {
  [K in keyof T as K extends string ? Lowercase<K> : K]: T[K]
}

/** Preserve string literals; other text schemas decode or encode as strings. */
export type TextOf<T> = T extends string ? T : string
