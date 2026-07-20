import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../src/httpServer";
import type { HttpConfig } from "../src/config";

const cfg: HttpConfig = {
  port: 0,
  publicUrl: "https://drive-mcp-uat.cloudsee.cloud",
  oauthIssuer: "https://drive-oauth-uat.cloudsee.cloud",
  baseUrl: "https://drive-api-uat.cloudsee.cloud",
  timeoutMs: 5000,
  logLevel: "error",
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createHttpServer(cfg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

describe("hosted HTTP server", () => {
  it("serves an unauthenticated health check", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("cloudsee-drive-mcp");
  });

  it("publishes protected-resource metadata pointing at the CloudSee Drive AS", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    expect(body.resource).toBe(cfg.publicUrl);
    expect(body.authorization_servers).toContain(cfg.oauthIssuer);
    expect(body.scopes_supported).toContain("drive:read");
  });

  it("rejects an unauthenticated MCP initialize with 401 + WWW-Authenticate", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
  });

  it("rejects a session-less, non-initialize POST with 400", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("answers CORS preflight", async () => {
    const res = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "https://claude.ai" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
