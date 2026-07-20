import type { Server } from "node:http";
import { loadHttpConfig, type HttpConfig } from "./config";
import { configureLogger, logger } from "./logger";
import { createHttpServer } from "./httpServer";
import { VERSION } from "./version";

// Entrypoint for the LOCAL HTTP dev server (Streamable HTTP, stateful) — for
// running the hosted server locally without AWS. The DEPLOYED hosted transport
// is the stateless Lambda handler in `src/lambda.ts`. The stdio entrypoint stays
// in `src/index.ts`. Run via `node dist/http.js` (the `start:http` script /
// `cloudsee-drive-mcp-http` bin).

function loadHttpConfigOrExit(): HttpConfig {
  try {
    return loadHttpConfig();
  } catch (err) {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exit(1);
  }
}

function main(): void {
  const config = loadHttpConfigOrExit();
  // No static secret to redact — each per-request client redacts its own token/secret.
  configureLogger({ level: config.logLevel });

  const server = createHttpServer(config);
  server.listen(config.port, () => {
    logger.info(
      `cloudsee-drive-mcp v${VERSION} (hosted) listening on :${config.port} — ` +
        `public ${config.publicUrl}, /v1 edge ${config.baseUrl}, OAuth issuer ${config.oauthIssuer}`,
    );
  });

  installShutdown(server);
}

function installShutdown(server: Server): void {
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} received — shutting down`);
    server.close(() => process.exit(0));
    // Don't hang forever on lingering SSE streams.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
