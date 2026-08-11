import { defineConfig } from "tsup";
import { packageVersion } from "./scripts/package-version.mjs";

// Build for the MCPB desktop extension (`npm run build:mcpb`).
//
// The bundle format allows shipping node_modules, but bundling the two runtime deps
// (@modelcontextprotocol/sdk + zod) into one file instead keeps the .mcpb an order of
// magnitude smaller and removes any chance of a install-time dependency resolution
// problem on a user's machine. Output lands in build/mcpb/server/, which is the layout
// the manifest's entry_point expects inside the archive.
//
// Only the stdio entry point is built: a desktop extension runs locally, so the HTTP
// transport has no role here.
//
// The define below is required, exactly as in tsup.config.ts: src/version.ts reads
// __MCP_SERVER_VERSION__ and nothing else supplies it, so dropping it makes the
// installed extension throw ReferenceError the moment Claude Desktop spawns it.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  outDir: "build/mcpb/server",
  outExtension: () => ({ js: ".js" }),
  noExternal: [/@modelcontextprotocol\/sdk/, "zod"],
  clean: true,
  dts: false,
  sourcemap: false,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
  shims: false,
  define: {
    __MCP_SERVER_VERSION__: JSON.stringify(packageVersion),
  },
});
