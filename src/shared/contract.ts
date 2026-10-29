import type { Encoding } from "./encoding"
export type { Encoding } from "./encoding"
/** The only contract format version this client reads. */
export const CONTRACT_VERSION = 7

/**
 * The runtime details a generated module exports as `contract`. Encodings record deviations from
 * defaults, schema-derived form content types, and explicit form serialization styles.
 */
export interface Contract<Endpoints = unknown> {
  /**
   * The format, so that a client and a contract that do not agree on it fail to compile, or to
   * start.
   */
  readonly version: typeof CONTRACT_VERSION
  /** Carries the generated `Endpoints` for inference; never set. */
  readonly types?: Endpoints
  readonly endpoints: { readonly [K in keyof Endpoints]: EndpointContract }
}

/** One endpoint's parameter encodings, request body, and response representations. */
export interface EndpointContract {
  readonly parameters?: {
    readonly path?: Readonly<Record<string, ParameterContract>>
    readonly query?: Readonly<Record<string, ParameterContract>>
    readonly header?: Readonly<Record<string, ParameterContract>>
    readonly cookie?: Readonly<Record<string, ParameterContract>>
  }
  readonly querystring?: {
    readonly required: boolean
    readonly content: Readonly<
      Record<string, { readonly encoding?: Readonly<Record<string, Encoding>> }>
    >
  }
  readonly requestBody?: {
    readonly required: boolean
    readonly content: Readonly<
      Record<string, { readonly encoding?: Readonly<Record<string, Encoding>> }>
    >
  }
  readonly responses: Readonly<
    Record<
      string,
      {
        readonly content?: Readonly<Record<string, object>>
      }
    >
  >
}

/** Presence and serialization of a declared parameter; schemas remain type-only. */
export interface ParameterContract {
  readonly required: boolean
  readonly encoding?: Encoding
}
