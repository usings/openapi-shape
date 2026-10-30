/** The empty object type: `Empty extends T` holds when every property of `T` is optional. */
export type Empty = Record<never, never>

/** The shape of one entry of a generated `Endpoints` interface. */
export interface Operation {
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
 * The operations of `Endpoints` a client calls, such as `"GET /pets"`: every key but those whose
 * method `fetch` refuses (`CONNECT`, `TRACE`, `TRACK`).
 */
export type Endpoint<Endpoints> = Callable<keyof Endpoints & string>

export type Callable<K> = K extends `${infer Method} ${string}`
  ? Uppercase<Method> extends "CONNECT" | "TRACE" | "TRACK"
    ? never
    : K
  : K

export type Essence<M extends string> = Lowercase<
  M extends `${infer E};${string}` ? Trim<E> : Trim<M>
>

/** Without the spaces and tabs around it (RFC 9110, OWS), as the client's run time trims them. */
type Trim<S extends string> = S extends ` ${infer T}` | `\t${infer T}`
  ? Trim<T>
  : S extends `${infer T} ` | `${infer T}\t`
    ? Trim<T>
    : S

/** JSON, and the wildcards that take it. */
export type IsJson<M extends string> =
  Essence<M> extends `${string}/json` | `${string}+json` | "*/*" | "application/*" ? true : false
