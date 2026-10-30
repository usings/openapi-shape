import { getEventListeners } from "node:events"
import { expect, it } from "vitest"
import { raceWithAbort } from "../../src/client/cancellation"

it("removes the listener for an already aborted signal while still observing pending rejection", async () => {
  const controller = new AbortController()
  const reason = { stopped: true }
  controller.abort(reason)
  const pending = Promise.withResolvers<void>()
  await expect(raceWithAbort(pending.promise, controller.signal)).rejects.toBe(reason)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  pending.reject(new Error("late failure"))
  await Promise.resolve()
})
