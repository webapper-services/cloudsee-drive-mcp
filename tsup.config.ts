import { defineConfig } from "tsup";
import { packageVersion } from "./scripts/package-version.mjs";

// Bundle the MCP server to self-contained ESM files with a Node shebang so
// `npm install -g` exposes a runnable `cloudsee-drive-mcp` bin on
// macOS / Linux / Windows. No native deps — pure JS output.
//   - dist/index.js → stdio transport (the NPM package / local install)
//   - dist/http.js  → Streamable-HTTP transport (the hosted Fargate deployment)
// The define below is required: src/version.ts reads __MCP_SERVER_VERSION__ and
// nothing else supplies it, so dropping it makes the published package throw
// ReferenceError the moment an MCP client spawns it.
export default defineConfig({
  entry: ["src/index.ts", "src/http.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
  shims: false,
  define: {
    __MCP_SERVER_VERSION__: JSON.stringify(packageVersion),
  },
});
