import { mediaParameters, mediaTypeEssence } from "../shared/media"

/** Fetch's MIME extraction from Content-Type, separate from declaration media keys. */
export function responseContentType(headers: Headers): string | undefined {
  const value = headers.get("content-type")
  if (value === null) return undefined
  let selected: string | undefined
  let previousEssence: string | undefined
  let charset: string | undefined
  let start = 0
  let quoted = false
  for (let i = 0; i <= value.length; i++) {
    const char = value[i]
    if (quoted && char === "\\") {
      i++
      continue
    }
    if (char === '"') quoted = !quoted
    if (i !== value.length && (char !== "," || quoted)) continue
    const item = value.slice(start, i).replaceAll(/^[\t\n\r ]+|[\t\n\r ]+$/g, "")
    start = i + 1
    const match =
      /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)[\t\n\r ]*(?:;|$)/.exec(item)
    if (!match) continue
    const candidate = `${match[1]}/${match[2]}`.toLowerCase()
    if (candidate === "*/*") continue
    const params = mediaParameters(item)
    if (candidate !== previousEssence) charset = undefined
    charset = params.get("charset") ?? charset
    selected =
      item + (charset && !params.has("charset") ? `;charset=${JSON.stringify(charset)}` : "")
    previousEssence = candidate
  }
  return selected
}

/** The essence of the same MIME value used for contract matching. */
export function responseMediaType(headers: Headers): string | undefined {
  const value = responseContentType(headers)
  return value?.split(";", 1)[0]?.trim().toLowerCase()
}

/** Resolve a concrete media type against exact declarations, then media ranges. */
export function matchDeclaredMedia<T>(
  content: Readonly<Record<string, T>>,
  actual: string,
): string | undefined {
  const essence = mediaTypeEssence(actual)
  const actualParameters = mediaParameters(actual)
  return Object.keys(content)
    .map((key) => {
      const declared = mediaTypeEssence(key)
      const score =
        declared === essence
          ? 2
          : declared === `${essence.split("/")[0]}/*`
            ? 1
            : declared === "*/*"
              ? 0
              : -1
      const params = mediaParameters(key)
      const matches = [...params].every(([name, value]) => actualParameters.get(name) === value)
      return { key, score: matches ? score : -1, parameters: params.size }
    })
    .filter((entry) => entry.score >= 0)
    .toSorted((a, b) => b.score - a.score || b.parameters - a.parameters)[0]?.key
}
