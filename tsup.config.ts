import { defineConfig } from "tsup";

// Bundle the MCP server to self-contained ESM files with a Node shebang so
// `npm install -g` exposes a runnable `cloudsee-drive-mcp` bin on
// macOS / Linux / Windows. No native deps — pure JS output.
//   - dist/index.js → stdio transport (the NPM package / local install)
//   - dist/http.js  → Streamable-HTTP transport (the hosted Fargate deployment)
export default defineConfig({
  entry: ["src/index.ts", "src/http.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
  shims: false,
});
