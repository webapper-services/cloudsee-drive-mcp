#!/usr/bin/env node
// End-to-end smoke test: spawn the built stdio server and perform a real MCP
// handshake + tools/list. Uses placeholder creds — listing tools makes no API
// call, so it runs fully offline and proves the bin starts and registers tools.
//   npm run build && node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...process.env,
    CLOUDSEE_API_KEY_ID: "smoke-id",
    CLOUDSEE_API_KEY_SECRET: "smoke-secret",
    CLOUDSEE_API_BASE_URL: "https://drive-api-uat.cloudsee.cloud",
    CLOUDSEE_LOG_LEVEL: "error",
  },
});

const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

console.log(`tools registered: ${tools.length}`);
console.log(tools.map((t) => `  - ${t.name}${t.annotations?.destructiveHint ? " [destructive]" : ""}`).join("\n"));

const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
console.log(`destructive (confirm-gated): ${destructive.join(", ")}`);

if (tools.length !== 17) {
  console.error(`EXPECTED 17 tools, got ${tools.length}`);
  process.exit(1);
}
console.log("SMOKE OK");
