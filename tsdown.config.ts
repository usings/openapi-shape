import { defineConfig } from "tsdown"

export default defineConfig({
  // Explicit names keep the public entry points stable.
  entry: { index: "src/core/index.ts", client: "src/client/index.ts", cli: "src/cli/index.ts" },
  dts: true,
  // The bin; importing it would run it.
  exports: { exclude: ["cli"] },
})
