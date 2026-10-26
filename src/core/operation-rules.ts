import { isRecord } from "./object"

/** Path Item method fields, including OpenAPI 3.2's query method in older descriptions. */
export const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
]

/** Select before loading or compiling schemas: the first querystring replaces ordinary queries. */
export function selectParameters<T extends { value: unknown }>(parameters: Iterable<T>): T[] {
  const list = [...parameters]
  const whole = list.find(
    (parameter) => isRecord(parameter.value) && parameter.value.in === "querystring",
  )
  if (whole === undefined) return list
  return list.filter((parameter) => {
    const location = isRecord(parameter.value) ? parameter.value.in : undefined
    return location === "querystring" ? parameter === whole : location !== "query"
  })
}
