/** Whether a serialization style explodes by default; deepObject requires explode: true. */
export function defaultExplode(style: string): boolean {
  return style === "form" || style === "cookie" || style === "deepObject"
}

/** How a value is serialized; generated form content types include schema-derived defaults. */
export interface Encoding {
  readonly style?: string
  readonly explode?: boolean
  readonly allowReserved?: boolean
  /** The media type of a parameter's `content`, or a form field's Encoding Object `contentType`. */
  readonly contentType?: string
  /** Encode each array item as contentType in a named form field. */
  readonly repeat?: boolean
}
