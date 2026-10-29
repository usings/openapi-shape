import { expectTypeOf } from "vitest"
import type { IsStringLiteral, IsUnion } from "../../src/client/types/utils"
expectTypeOf<IsUnion<never>>().toEqualTypeOf<false>()
expectTypeOf<IsUnion<{ a: 1 } | { a: number }>>().toEqualTypeOf<true>()
expectTypeOf<IsUnion<any>>().toEqualTypeOf<false>()
expectTypeOf<IsStringLiteral<any>>().toEqualTypeOf<false>()
expectTypeOf<IsStringLiteral<never>>().toEqualTypeOf<false>()
expectTypeOf<IsStringLiteral<"a" | "b">>().toEqualTypeOf<true>()
interface Brand {
  readonly __brand: unique symbol
}
expectTypeOf<IsStringLiteral<string & Brand>>().toEqualTypeOf<false>()
expectTypeOf<IsStringLiteral<"application/json" & Brand>>().toEqualTypeOf<true>()
