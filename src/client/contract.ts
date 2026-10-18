// The published format a generated module exports as `contract`: what the
// generator writes and the client reads. A change to it is a new `version`,
// which the generator writes and the client accepts; a client keeps accepting
// the versions it can still read, so committed contracts keep working.

/** The format version of the contracts this client reads. */
export const CONTRACT_VERSION = 1

/**
 * The runtime details a generated module exports as `contract`. Encodings are listed only where
 * they differ from OpenAPI's defaults.
 */
export interface Contract<Endpoints = unknown> {
  /**
   * The format, so that a client and a contract that do not agree on it fail to compile, or to
   * start.
   */
  readonly version: typeof CONTRACT_VERSION
  /** Carries the generated `Endpoints` for inference; never set. */
  readonly types?: Endpoints
  readonly endpoints: { readonly [K in keyof Endpoints]?: EndpointContract }
}

/** How a value is serialized; absent fields take OpenAPI's defaults. */
export interface Encoding {
  readonly style?: string
  readonly explode?: boolean
  readonly allowReserved?: boolean
  /** The media type of a parameter's `content`, or a form field's Encoding Object `contentType`. */
  readonly contentType?: string
}

export interface EndpointContract {
  readonly params?: Readonly<Record<string, Encoding>>
  readonly query?: Readonly<Record<string, Encoding>>
  /** Media type of the 3.2 `querystring` parameter. */
  readonly querystring?: string
  readonly headers?: Readonly<Record<string, Encoding>>
  /** The media type sent when the call names none and JSON is not accepted. */
  readonly contentType?: string
  /**
   * The label of the JSON the client encodes when the call names no media type, where it is not
   * `application/json`: the declared one, parameters and all.
   */
  readonly json?: string
  /** Encoding Objects of a form body, by field. */
  readonly encoding?: Readonly<Record<string, Encoding>>
}
