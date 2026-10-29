/** Function parameter inference turns a union into an intersection (as in type-fest). */
export type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never
