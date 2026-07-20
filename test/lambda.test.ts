import { describe, it, expect, beforeAll } from "vitest";

// The handler reads config from env at first call (cached); set it before importing.
beforeAll(() => {
  process.env.MCP_PUBLIC_URL = "https://drive-mcp-uat.cloudsee.cloud";
  process.env.CLOUDSEE_OAUTH_ISSUER = "https://drive-api-uat.cloudsee.cloud";
  process.env.CLOUDSEE_LOG_LEVEL = "error";
});

const ACCEPT = "application/json, text/event-stream";

interface Event {
  httpMethod: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
}
function ev(httpMethod: string, path: string, headers: Record<string, string> = {}, body: string | null = null): Event {
  return { httpMethod, path, headers, body, isBase64Encoded: false };
}
function initBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
}

async function invoke(event: Event) {
  const { handler } = await import("../src/lambda");
  return handler(event);
}

describe("lambda handler (stateless MCP over API Gateway)", () => {
  it("serves an unauthenticated health check", async () => {
    const res = await invoke(ev("GET", "/healthz"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("publishes protected-resource metadata pointing at the CloudSee Drive AS", async () => {
    const res = await invoke(ev("GET", "/.well-known/oauth-protected-resource"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { authorization_servers: string[]; scopes_supported: string[] };
    expect(body.authorization_servers).toContain("https://drive-api-uat.cloudsee.cloud");
    expect(body.scopes_supported).toContain("drive:read");
  });

  it("rejects an unauthenticated MCP request with 401 + WWW-Authenticate", async () => {
    const res = await invoke(
      ev("POST", "/mcp", { "Content-Type": "application/json", Accept: ACCEPT }, initBody()),
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers?.["WWW-Authenticate"]).toContain("/.well-known/oauth-protected-resource");
  });

  it("handles an authenticated initialize statelessly (no prior session)", async () => {
    const res = await invoke(
      ev("POST", "/mcp", { "Content-Type": "application/json", Accept: ACCEPT, Authorization: "Bearer faketoken" }, initBody()),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("cloudsee-drive-mcp"); // serverInfo
  });

  it("answers tools/list on a fresh stateless server (proves no initialize gate)", async () => {
    const res = await invoke(
      ev(
        "POST",
        "/mcp",
        { "Content-Type": "application/json", Accept: ACCEPT, Authorization: "Bearer faketoken" },
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      ),
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { result?: { tools?: unknown[] } };
    expect(parsed.result?.tools?.length).toBe(17);
  });

  it("CORS preflight", async () => {
    const res = await invoke(ev("OPTIONS", "/mcp", { Origin: "https://claude.ai" }));
    expect(res.statusCode).toBe(204);
    expect(res.headers?.["Access-Control-Allow-Methods"]).toContain("POST");
  });
});
