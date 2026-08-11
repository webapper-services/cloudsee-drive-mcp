import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "./server";
import { hostedTools } from "./tools/index";
import type { Config, HttpConfig } from "./config";

// Shared OAuth resource-server helpers for the hosted transports (the Lambda
// handler in `src/lambda.ts` and the local HTTP dev server in `src/httpServer.ts`).
// The hosted server is the MCP resource server — it advertises the
// CloudSee Drive authorization server, challenges unauthenticated callers, and
// builds a per-request MCP server bound to the caller's OAuth access token.

export const OAUTH_SCOPES = ["drive:read", "drive:download", "drive:write", "drive:delete"] as const;

export type JsonRpcId = string | number | null;

/** RFC 9728 protected-resource metadata advertising the CloudSee Drive AS + scopes. */
export function protectedResourceMetadata(cfg: HttpConfig): Record<string, unknown> {
  return {
    resource: cfg.publicUrl,
    authorization_servers: [cfg.oauthIssuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [...OAUTH_SCOPES],
    resource_name: "CloudSee Drive MCP server",
    resource_documentation: "https://github.com/webapper-services/cloudsee-drive-mcp#readme",
  };
}

/** The `WWW-Authenticate` challenge value pointing clients at the resource metadata. */
export function wwwAuthenticate(cfg: HttpConfig): string {
  return `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`;
}

/** Extract a Bearer token from an Authorization header value. */
export function parseBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : undefined;
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

/** URL-safe base64 decode of a JWT segment (no verification). */
function decodeJwtSegment(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve an OAuth access token into the credential material the hosted server sends
 * to /v1. Two shapes are accepted:
 *
 *  - **Signed token (current):** a bridge-signed JWT whose payload carries the caller's
 *    public `kid` (ApiKeyId) but NO secret. We read `kid` from the (unverified) payload
 *    to set the `X-Api-Key` gateway header, and forward the JWT itself as the bearer
 *    credential — the CloudSee Drive API verifies its signature and needs no secret. The MCP
 *    server never sees or handles a secret.
 *  - **Legacy `base64url("ApiKeyId:secret")`:** kept for back-compat; returns id+secret.
 *
 * The ApiKeyId IS the API Gateway `X-Api-Key` value (usage-plan keys are minted with
 * `generateDistinctId:false`), so `kid` is everything the gateway needs.
 */
export function decodeAccessToken(token: string): { apiKeyId: string; secret?: string; bearerToken?: string } {
  // Signed JWT: three dot-separated segments; the middle is the payload.
  const parts = token.split(".");
  if (parts.length === 3) {
    const payload = decodeJwtSegment(parts[1]);
    const kid = payload && typeof payload.kid === "string" ? payload.kid : undefined;
    if (kid) return { apiKeyId: kid, bearerToken: token };
  }
  // Legacy base64url "id:secret".
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep > 0) return { apiKeyId: decoded.slice(0, sep), secret: decoded.slice(sep + 1) };
  } catch {
    // fall through to the best-effort path below
  }
  // Unrecognized — forward it as the bearer credential; let the CloudSee Drive API decide.
  return { apiKeyId: token, bearerToken: token };
}

/**
 * Build a per-request MCP server bound to one caller's OAuth access token. The token
 * identifies the user's FIXED CloudSee key (`X-Api-Key` == `ApiKeyId`, rate-limited per
 * user on the CloudSee Drive side) and, for signed tokens, IS the bearer credential /v1
 * verifies. No server-held key, and no secret ever handled for signed tokens.
 */
export function buildUserMcpServer(cfg: HttpConfig, userToken: string): McpServer {
  const { apiKeyId, secret, bearerToken } = decodeAccessToken(userToken);
  const sessionConfig: Config = {
    apiKeyId,
    apiKeySecret: secret,
    bearerToken,
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.timeoutMs,
    logLevel: cfg.logLevel,
    defaultBucket: cfg.defaultBucket,
  };
  // hostedTools, not allTools: `upload_file` here takes the file's contents, because this
  // server cannot read the caller's disk and the caller cannot PUT to S3 itself.
  return createServer(sessionConfig, hostedTools);
}
