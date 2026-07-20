import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadHttpConfig, type HttpConfig } from "./config";
import { configureLogger, logger } from "./logger";
import { VERSION } from "./version";
import {
  buildUserMcpServer,
  jsonRpcError,
  parseBearer,
  protectedResourceMetadata,
  wwwAuthenticate,
} from "./oauthResource";

// AWS Lambda handler for the HOSTED MCP server, behind API
// Gateway at drive-mcp[-uat].cloudsee.cloud. MCP runs in **stateless** mode: each
// request is an independent JSON-RPC POST (no SSE, no in-memory sessions), so a
// fresh McpServer + transport is built per invocation and bound to the caller's
// OAuth access token — which IS their CloudSee credential (base64url("ApiKeyId:secret")),
// decoded and sent like the stdio client (X-Api-Key == ApiKeyId, per user). The server
// holds no key of its own. Logging is stderr-only; tokens are never logged or returned.

// API Gateway proxy event/result (REST v1 fields, with HTTP API v2 fallbacks).
interface ApiGatewayEvent {
  httpMethod?: string;
  path?: string;
  rawPath?: string;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; path?: string } };
}

interface ApiGatewayResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

// Loaded once per execution environment (cold start), reused across warm invocations.
let cachedConfig: HttpConfig | undefined;
function getConfig(): HttpConfig {
  if (!cachedConfig) {
    cachedConfig = loadHttpConfig();
    // No static secret to redact — each per-request client redacts its own token/secret.
    configureLogger({ level: cachedConfig.logLevel });
  }
  return cachedConfig;
}

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResult> {
  let cfg: HttpConfig;
  try {
    cfg = getConfig();
  } catch (err) {
    process.stderr.write(`Fatal config error: ${err instanceof Error ? err.message : String(err)}\n`);
    return jsonResult(500, { error: "server_misconfigured" });
  }

  const method = (event.httpMethod ?? event.requestContext?.http?.method ?? "GET").toUpperCase();
  const path = event.path ?? event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const origin = headerLookup(event.headers, "origin");

  try {
    if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders(origin), body: "" };

    if (path === "/healthz" || path.endsWith("/healthz") || path === "/health") {
      return jsonResult(200, { status: "ok", service: "cloudsee-drive-mcp", version: VERSION }, origin);
    }
    if (path.endsWith("/.well-known/oauth-protected-resource") && method === "GET") {
      return jsonResult(200, protectedResourceMetadata(cfg), origin);
    }
    if (path.endsWith("/.well-known/oauth-authorization-server") && method === "GET") {
      return {
        statusCode: 302,
        headers: { Location: `${cfg.oauthIssuer}/.well-known/oauth-authorization-server`, ...corsHeaders(origin) },
        body: "",
      };
    }
    if (path === "/mcp" || path.endsWith("/mcp")) {
      return await handleMcp(event, cfg, method, origin);
    }
    return jsonResult(404, { error: "not_found" }, origin);
  } catch (err) {
    logger.error("unhandled Lambda request error", err instanceof Error ? err.message : String(err));
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      body: JSON.stringify(jsonRpcError(null, -32603, "Internal server error")),
    };
  }
}

async function handleMcp(
  event: ApiGatewayEvent,
  cfg: HttpConfig,
  method: string,
  origin: string | undefined,
): Promise<ApiGatewayResult> {
  const token = parseBearer(headerLookup(event.headers, "authorization"));
  if (!token) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": wwwAuthenticate(cfg), ...corsHeaders(origin) },
      body: JSON.stringify(
        jsonRpcError(null, -32001, "Authentication required — authorize via the linked OAuth resource metadata."),
      ),
    };
  }

  const rawBody = decodeBody(event);
  const webRequest = new Request(`${cfg.publicUrl}/mcp`, {
    method,
    headers: toHeaders(event.headers),
    body: method === "GET" || method === "DELETE" || method === "HEAD" ? undefined : rawBody,
  });
  const parsedBody = rawBody ? safeParse(rawBody) : undefined;

  // Stateless: a fresh server + transport per request (no session persistence on Lambda).
  const server = buildUserMcpServer(cfg, token);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const webResponse = await transport.handleRequest(webRequest, { parsedBody });
    const body = await webResponse.text();
    const headers: Record<string, string> = { ...corsHeaders(origin) };
    webResponse.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { statusCode: webResponse.status, headers, body, isBase64Encoded: false };
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------
// API Gateway <-> Web standard helpers
// ----------------------------------------------------------------------------

function jsonResult(status: number, body: unknown, origin?: string): ApiGatewayResult {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    body: JSON.stringify(body),
  };
}

function corsHeaders(origin?: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  };
}

function headerLookup(headers: ApiGatewayEvent["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] ?? undefined;
  }
  return undefined;
}

function toHeaders(headers: ApiGatewayEvent["headers"]): Headers {
  const out = new Headers();
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") out.set(key, value);
    }
  }
  return out;
}

function decodeBody(event: ApiGatewayEvent): string | undefined {
  if (event.body == null) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
