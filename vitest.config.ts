import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Many tests launch tsc; allow for compiler startup and contention on CI runners.
    testTimeout: 30_000,
  },
})
