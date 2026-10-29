import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.spec.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "browser",
          include: ["tests/**/*.browser.ts"],
          globalSetup: ["tests/support/browser.ts"],
          testTimeout: 30_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
})
