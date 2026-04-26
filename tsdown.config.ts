import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/client.ts", "src/cli.ts"],
  dts: true,
  exports: true,
});
