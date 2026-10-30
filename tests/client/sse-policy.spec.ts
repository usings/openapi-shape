import { expect, it } from "vitest"
import { resolveSseReconnectPolicy } from "../../src/client/streams/sse-reconnect"
import type { ReconnectOptions } from "../../src/client/types/stream"

it.each([[], { delay: null }, {}])("preserves default normalization of %j", (input) => {
  expect(resolveSseReconnectPolicy(input as ReconnectOptions)).toStrictEqual({
    maxAttempts: Infinity,
    initialDelayMs: 1000,
    replay: true,
  })
})
