import { defineConfig } from "vitest/config";
import { packageVersion } from "./scripts/package-version.mjs";

export default defineConfig({
  // Mirrors the define in tsup.config.ts and infra/tsup.lambda.config.ts so the
  // sources under test resolve __MCP_SERVER_VERSION__ exactly like a built bundle.
  define: {
    __MCP_SERVER_VERSION__: JSON.stringify(packageVersion),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
