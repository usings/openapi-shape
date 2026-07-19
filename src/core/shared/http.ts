export type HttpMethod = "get" | "post" | "put" | "delete" | "patch" | "head" | "options" | "trace"

/** HTTP methods in OpenAPI Path Item declaration order. */
export const HTTP_METHODS: HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]
