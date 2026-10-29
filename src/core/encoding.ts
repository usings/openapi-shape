import { defaultExplode } from "../shared/encoding"
import type { Encoding } from "./model"
import { isRecord } from "./object"

/**
 * A parameter's or Encoding Object's serialization, where it differs from the default: then always
 * with its style and explode, so it reads on its own.
 */
export function encodingOf(
  value: Record<string, unknown>,
  defaultStyle: string,
  /** For an Encoding Object of a form body. */
  field = false,
): Encoding | undefined {
  // A parameter with `content` is serialized as that media type; style does not apply.
  if (!field && isRecord(value.content)) {
    const [mediaType] = Object.keys(value.content)
    return mediaType === undefined ? undefined : { contentType: mediaType }
  }
  const out: Encoding = {}
  const style = typeof value.style === "string" ? value.style : defaultStyle
  const explode = typeof value.explode === "boolean" ? value.explode : defaultExplode(style)
  const allowReserved = value.allowReserved === true
  if (
    (field && ("style" in value || "explode" in value || "allowReserved" in value)) ||
    style !== defaultStyle ||
    explode !== defaultExplode(defaultStyle) ||
    allowReserved
  ) {
    out.style = style
    out.explode = explode
    if (allowReserved) out.allowReserved = true
  }
  // A form field's contentType applies unless style, explode, or allowReserved says otherwise.
  if (
    field &&
    typeof value.contentType === "string" &&
    !("style" in value || "explode" in value || "allowReserved" in value)
  ) {
    out.contentType = value.contentType
  }
  return Object.keys(out).length > 0 ? out : undefined
}
