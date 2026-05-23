export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isObjectAdditional<T extends object = Record<string, unknown>>(
  value: unknown,
): value is T {
  return isObject(value) && !Array.isArray(value)
}
