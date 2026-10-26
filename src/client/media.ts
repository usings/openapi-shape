/** Fetch's MIME extraction from Content-Type, separate from declaration media keys. */
export function responseMediaType(headers: Headers): string | undefined {
  const value = headers.get("content-type")
  if (value === null) return undefined
  let essence: string | undefined
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
    if (candidate !== "*/*") essence = candidate
  }
  return essence
}
