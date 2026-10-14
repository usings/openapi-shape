/**
 * Identifier characters: ASCII, plus letters of long-established scripts
 * (Latin, Greek, Cyrillic, CJK, kana, Hangul). Letters added in recent Unicode
 * versions are left out: engines and TypeScript disagree about them, which
 * would make output invalid or differ between environments.
 */
const STABLE_LETTERS: Array<[number, number]> = [
  [0x00c0, 0x024f],
  [0x0370, 0x03ff],
  [0x0400, 0x04ff],
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7a3],
]

function isIdentifierChar(char: string, first: boolean): boolean {
  if (/[A-Za-z_$]/.test(char) || (!first && /[0-9]/.test(char))) return true
  const code = char.codePointAt(0) ?? 0
  return /\p{L}/u.test(char) && STABLE_LETTERS.some(([from, to]) => code >= from && code <= to)
}

function isIdentifier(name: string): boolean {
  const chars = [...name]
  return chars.length > 0 && chars.every((char, i) => isIdentifierChar(char, i === 0))
}

// Reserved words, plus the predefined type names a declaration cannot take.
const RESERVED = new Set(
  (
    "abstract any as asserts async await bigint boolean break case catch class const constructor " +
    "continue debugger declare default delete do else enum export extends false finally for from " +
    "function get if implements import in infer instanceof interface is keyof let module namespace " +
    "never new null number object of package private protected public readonly require return " +
    "satisfies set static string super switch symbol this throw true try type typeof undefined " +
    "unique unknown var void while with yield"
  ).split(" "),
)

/** Turn an arbitrary name into a TypeScript identifier usable as a declaration name. */
export function toIdentifier(name: string): string {
  let out = [...name].map((char) => (isIdentifierChar(char, false) ? char : "_")).join("")
  if (!isIdentifier(out)) out = `_${out}`
  if (RESERVED.has(out)) out = `_${out}`
  return out
}

/** Render a property name, quoting it unless it is a plain identifier. */
export function propertyKey(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name)
}

/** First of `base`, `base2`, `base3`, … not in `taken`. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`
    if (!taken.has(candidate)) return candidate
  }
}
