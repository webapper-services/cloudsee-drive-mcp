import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config";
import { configureLogger, logger } from "./logger";
import { createServer } from "./server";
import { VERSION } from "./version";

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    // Config errors are fatal and printed to stderr (not stdout — the transport).
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  // Register the credential material for redaction before anything else runs.
  configureLogger({
    level: config.logLevel,
    redact: [config.apiKeySecret, config.bearerToken].filter((v): v is string => !!v),
  });

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(`cloudsee-drive-mcp v${VERSION} ready on stdio (base: ${config.baseUrl})`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
