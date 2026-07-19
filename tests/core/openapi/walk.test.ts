import { describe, expect, it } from "vitest"
import { mapDocumentSchemas } from "../../../src/core/openapi/walk"

describe("mapDocumentSchemas", () => {
  it("visits false schemas in parameters and media types", () => {
    const locations: string[] = []
    mapDocumentSchemas(
      {
        paths: {
          "/x": {
            post: {
              parameters: [{ name: "blocked", in: "query", schema: false }],
              requestBody: { content: { "application/json": { schema: false } } },
              responses: {
                "200": { content: { "application/json": { schema: false } } },
              },
            },
          },
        },
      },
      (schema, location) => {
        if (schema === false) locations.push(location)
        return schema
      },
    )

    expect(locations).toStrictEqual([
      "/paths/~1x/post/parameters/0/schema",
      "/paths/~1x/post/requestBody/content/application~1json/schema",
      "/paths/~1x/post/responses/200/content/application~1json/schema",
    ])
  })
})
