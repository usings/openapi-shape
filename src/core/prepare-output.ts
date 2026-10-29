import type { EndpointContract } from "../shared/contract"
import { classifyMediaType } from "./media-types"
import type { ApiModel, OperationModel, Side } from "./model"
import { endpointContract } from "./output-contract"
import { TypeProjection } from "./type-projection"

/** Project schemas for each exchange and record the settings needed by the Fetch client. */
export async function prepareOutput(
  model: ApiModel,
  workpoint?: () => Promise<void> | undefined,
): Promise<ModuleModel> {
  const projection = new TypeProjection(model.declarations)
  const operations: EndpointOutput[] = []
  for (const operation of model.operations) {
    operations.push({
      ...project(operation, projection, "request"),
      contract: endpointContract(operation),
    })
    const pending = workpoint?.()
    // oxlint-disable-next-line no-await-in-loop -- yield between independent operations
    if (pending) await pending
  }
  const webhooks = model.webhooks.map((op) => project(op, projection, "response"))
  const callbacks = model.callbacks.map((op) => project(op, projection, "response"))
  return { ...model, operations, webhooks, callbacks, declarations: projection.declarations }
}

function project(op: OperationModel, projection: TypeProjection, sent: Side): OperationModel {
  const received = sent === "request" ? "response" : "request"
  return {
    ...op,
    params: op.params.map((f) => projection.field(f, sent)),
    query: op.query.map((f) => projection.field(f, sent)),
    headers: op.headers.map((f) => projection.field(f, sent)),
    cookies: op.cookies.map((f) => projection.field(f, sent)),
    ...(op.querystring
      ? {
          querystring: {
            ...op.querystring,
            type: projection.type(op.querystring.type, sent),
          },
        }
      : {}),
    ...(op.body
      ? {
          body: {
            ...op.body,
            content: op.body.content.map((m) => ({
              ...m,
              type:
                sent === "request" && classifyMediaType(m.mediaType) === "multipart"
                  ? projection.multipart(m.type, m.encoding)
                  : projection.type(m.type, sent),
            })),
          },
        }
      : {}),
    responses: op.responses.map((r) => ({
      ...r,
      headers: r.headers.map((f) => projection.field(f, received)),
      content: r.content.map((m) => ({ ...m, type: projection.type(m.type, received) })),
    })),
  }
}

/** Projected model ready for TypeScript output. */
export interface ModuleModel extends Omit<ApiModel, "operations"> {
  operations: EndpointOutput[]
}

export interface EndpointOutput extends OperationModel {
  contract: EndpointContract
}
