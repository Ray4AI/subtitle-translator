import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `@/*` -> `./src/*`, mirroring tsconfig.json's `paths`. Without this every
// module that crosses the alias boundary fails to load in tests.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // scripts/ holds the CLI; src/ holds the engine. Both are plain TS with no
    // DOM and no React, so the node environment is enough.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
