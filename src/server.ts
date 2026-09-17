import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloudSeeClient } from "./client/CloudSeeClient";
import { allTools, type ToolDef } from "./tools/index";
import { logger } from "./logger";
import { VERSION } from "./version";
import type { Config } from "./config";

/**
 * Build the MCP server: one CloudSeeClient shared across all tools, each tool
 * registered with its Zod input schema and MCP annotations. Tool handler errors
 * are caught and returned as `isError` results (never thrown across the
 * transport), and are logged to stderr with the secret redacted.
 *
 * For the hosted server, one server is built per request from the caller's
 * decoded OAuth credential, with the hosted tool set (see
 * `oauthResource.buildUserMcpServer` and `tools/index.hostedTools`).
 */
export function createServer(config: Config, tools: ToolDef[] = allTools): McpServer {
  const client = new CloudSeeClient(config);
  const server = new McpServer({ name: "cloudsee-drive-mcp", version: VERSION });
  // What `get_version` answers with. Assembled here because this is the only place that holds
  // both the config and the tool set this transport actually registered.
  const serverInfo = { baseUrl: config.baseUrl, toolCount: tools.length };

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args ?? {}, { client, defaultBucket: config.defaultBucket, serverInfo });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`tool "${tool.name}" failed`, message);
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }

  logger.info(`registered ${tools.length} tools`);
  return server;
}
