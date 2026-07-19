export function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1")
}

export function decodePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~")
}

export function appendPointer(base: string, ...segments: Array<string | number>): string {
  return `${base}${segments.map((segment) => `/${escapePointerSegment(String(segment))}`).join("")}`
}

export function pointer(...segments: Array<string | number>): string {
  return appendPointer("", ...segments)
}
