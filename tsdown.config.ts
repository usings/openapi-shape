import { defineConfig } from "tsdown"

export default defineConfig({
  // Named, so that each stage directory can keep an index.ts.
  entry: { index: "src/index.ts", client: "src/client/index.ts", cli: "src/cli/index.ts" },
  dts: true,
  // The bin; importing it would run it.
  exports: { exclude: ["cli"] },
})
