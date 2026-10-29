import type { EndpointContract } from "../shared/contract"
import type { Field, OperationModel } from "./model"

export function endpointContract(op: OperationModel): EndpointContract {
  const content = op.body?.content ?? []
  const locations: Array<[string, Field[]]> = [
    ["path", op.params],
    ["query", op.query],
    ["header", op.headers],
    ["cookie", op.cookies],
  ]
  const parameters = Object.fromEntries(
    locations.flatMap(([location, list]) => {
      return list.length > 0
        ? [
            [
              location,
              Object.fromEntries(
                list.map((f) => [
                  f.name,
                  { required: f.required, ...(f.encoding ? { encoding: f.encoding } : {}) },
                ]),
              ),
            ],
          ]
        : []
    }),
  )
  return {
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    ...(op.querystring?.mediaType
      ? {
          querystring: {
            required: op.querystring.required,
            content: {
              [op.querystring.mediaType]: op.querystring.encoding
                ? { encoding: op.querystring.encoding }
                : {},
            },
          },
        }
      : {}),
    ...(op.body && content.length > 0
      ? {
          requestBody: {
            required: op.body.required,
            content: Object.fromEntries(
              content.map((m) => [m.mediaType, m.encoding ? { encoding: m.encoding } : {}]),
            ),
          },
        }
      : {}),
    responses: Object.fromEntries(
      op.responses.map((r) => [
        r.status,
        r.content.length > 0
          ? {
              content: Object.fromEntries(r.content.map((m) => [m.mediaType, {}])),
            }
          : {},
      ]),
    ),
  }
}
