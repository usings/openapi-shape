import type { EndpointContract } from "../shared/contract"

export function resolveResponseDeclaration(endpoint: EndpointContract, status: number) {
  const responses = endpoint.responses
  return (
    responses[String(status)] ?? responses[`${Math.floor(status / 100)}XX`] ?? responses.default
  )
}
