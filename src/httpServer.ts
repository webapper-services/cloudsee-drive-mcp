import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "./logger";
import { VERSION } from "./version";
import {
  buildUserMcpServer,
  jsonRpcError,
  parseBearer,
  protectedResourceMetadata,
  wwwAuthenticate,
  type JsonRpcId,
} from "./oauthResource";
import type { HttpConfig } from "./config";

// Local HTTP dev server (Streamable HTTP, stateful sessions) for running the
// hosted MCP server outside AWS — `npm run start:http` / the `cloudsee-drive-mcp-http`
// bin. The deployed transport is the stateless Lambda handler in `src/lambda.ts`;
// both share the OAuth resource-server logic in `src/oauthResource.ts`. stdout is
// not a transport here, but logging stays on stderr for consistency.

/** One live transport per MCP session id (stateful Streamable HTTP). */
type SessionStore = Map<string, StreamableHTTPServerTransport>;

/**
 * Build the local HTTP server WITHOUT listening — pure and importable (the
 * `src/http.ts` entrypoint wires config + `listen`; tests use it directly).
 */
export function createHttpServer(cfg: HttpConfig): http.Server {
  const sessions: SessionStore = new Map();
  return http.createServer((req, res) => {
    void handle(req, res, cfg, sessions);
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: HttpConfig,
  sessions: SessionStore,
): Promise<void> {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    // Unauthenticated health check.
    if (path === "/healthz" || path === "/health") {
      sendJson(res, 200, { status: "ok", service: "cloudsee-drive-mcp", version: VERSION });
      return;
    }

    // RFC 9728 — protected-resource metadata pointing clients at the CloudSee Drive AS.
    if (path === "/.well-known/oauth-protected-resource" && req.method === "GET") {
      sendJson(res, 200, protectedResourceMetadata(cfg));
      return;
    }
    // Convenience: discovery for the authorization server lives on the issuer.
    if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      res.writeHead(302, { Location: `${cfg.oauthIssuer}/.well-known/oauth-authorization-server` }).end();
      return;
    }

    if (path === "/mcp") {
      await handleMcp(req, res, cfg, sessions);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    logger.error("unhandled HTTP request error", err instanceof Error ? err.message : String(err));
    if (!res.headersSent) sendJson(res, 500, jsonRpcError(null, -32603, "Internal server error"));
    else res.end();
  }
}

async function handleMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: HttpConfig,
  sessions: SessionStore,
): Promise<void> {
  const sessionId = headerStr(req.headers["mcp-session-id"]);

  // Existing session: route POST (messages) / GET (SSE) / DELETE (close).
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      sendJson(res, 404, jsonRpcError(null, -32001, "Unknown or expired MCP session — re-initialize."));
      return;
    }
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
    return;
  }

  // No session yet — the only valid first message is an authenticated `initialize`.
  if (req.method !== "POST") {
    sendJson(res, 400, jsonRpcError(null, -32600, "Missing Mcp-Session-Id (no active MCP session)."));
    return;
  }
  const body = await readJsonBody(req);
  if (!isInitializeRequest(body)) {
    sendJson(res, 400, jsonRpcError(idOf(body), -32600, "Missing Mcp-Session-Id (no active MCP session)."));
    return;
  }

  // OAuth resource-server gate: a valid Bearer access token is required to open a session.
  const token = parseBearer(headerStr(req.headers["authorization"]));
  if (!token) {
    res.setHeader("WWW-Authenticate", wwwAuthenticate(cfg));
    sendJson(res, 401, jsonRpcError(idOf(body), -32001, "Authentication required — authorize via the linked OAuth resource metadata."));
    return;
  }

  const mcp = buildUserMcpServer(cfg, token);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, transport);
      logger.info(`MCP session opened (${sid}); ${sessions.size} active`);
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
      logger.info(`MCP session closed (${sid}); ${sessions.size} active`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ----------------------------------------------------------------------------
// node:http helpers
// ----------------------------------------------------------------------------

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB request cap

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isInitializeRequest(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "initialize",
  );
}

function idOf(body: unknown): JsonRpcId {
  const m = Array.isArray(body) ? body[0] : body;
  if (m && typeof m === "object") {
    const id = (m as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

function headerStr(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", headerStr(req.headers.origin) ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
