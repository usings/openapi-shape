import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts", "src/cli.ts"],
  dts: true,
  // The CLI is a bin; importing it would run it.
  exports: { exclude: ["cli"] },
})
