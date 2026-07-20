import { z } from "zod";
import { CloudSeeError } from "./errors";
import type { LogLevel } from "./logger";

export const DEFAULT_BASE_URL = "https://drive-api.cloudsee.cloud";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_PORT = 3000;

export interface Config {
  apiKeyId: string;
  // Direct API-key auth (stdio/env path): the id+secret pair. Omitted on the hosted
  // OAuth path, which authenticates with a signed bearer token instead (see below).
  apiKeySecret?: string;
  // Hosted OAuth path: a bridge-signed access token carrying this apiKeyId. When set,
  // the client authenticates with `Authorization: Bearer <token>` + `X-Api-Key` and
  // sends NO secret. Mutually exclusive with apiKeySecret in practice.
  bearerToken?: string;
  baseUrl: string;
  defaultBucket?: string;
  timeoutMs: number;
  logLevel: LogLevel;
}

const envSchema = z.object({
  CLOUDSEE_API_KEY_ID: z.string().trim().min(1, "is required (your CloudSee Drive API key id)"),
  CLOUDSEE_API_KEY_SECRET: z.string().trim().min(1, "is required (the matching API key secret)"),
  CLOUDSEE_API_BASE_URL: z.string().url("must be a valid URL").optional(),
  CLOUDSEE_DEFAULT_BUCKET: z.string().trim().min(1).optional(),
  CLOUDSEE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLOUDSEE_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).optional(),
});

/**
 * Load and validate configuration from the environment. Throws a CloudSeeError
 * with an actionable, secret-free message when required vars are missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".")} ${i.message}`).join("\n");
    throw new CloudSeeError(
      `CloudSee Drive MCP server is not configured:\n${issues}\n\n` +
        `Set the required environment variables (see .env.example or the README).`,
      { code: "config" },
    );
  }
  const e = parsed.data;
  return {
    apiKeyId: e.CLOUDSEE_API_KEY_ID,
    apiKeySecret: e.CLOUDSEE_API_KEY_SECRET,
    baseUrl: (e.CLOUDSEE_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    defaultBucket: e.CLOUDSEE_DEFAULT_BUCKET,
    timeoutMs: e.CLOUDSEE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    logLevel: e.CLOUDSEE_LOG_LEVEL ?? "info",
  };
}

/**
 * Configuration for the **hosted** (remote) transport — the Lambda + API Gateway
 * deployment at drive-mcp[-uat].cloudsee.cloud (also used by the local HTTP dev
 * server, `npm run start:http`). Unlike the stdio config this carries NO API key:
 * it is multi-tenant, and each caller's credential arrives per-request in their
 * OAuth access token (decoded in `oauthResource.buildUserMcpServer`). This object
 * holds only non-secret per-stage settings. This is the MCP resource server.
 */
export interface HttpConfig {
  /** Port the local HTTP dev server listens on. Unused on Lambda. */
  port: number;
  /** Public https origin of THIS server, e.g. https://drive-mcp-uat.cloudsee.cloud — advertised in the protected-resource metadata. */
  publicUrl: string;
  /** The CloudSee Drive OAuth authorization-server issuer base, e.g. https://drive-oauth-uat.cloudsee.cloud. */
  oauthIssuer: string;
  /** Base URL of the CloudSee `/v1` data plane — the `drive-api*` host, a DISTINCT host from the OAuth issuer. */
  baseUrl: string;
  timeoutMs: number;
  logLevel: LogLevel;
  defaultBucket?: string;
}

const httpEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().optional(),
  MCP_PUBLIC_URL: z
    .string()
    .url("must be a valid URL (the public https origin of this server, e.g. https://drive-mcp-uat.cloudsee.cloud)"),
  CLOUDSEE_OAUTH_ISSUER: z
    .string()
    .url("must be a valid URL (the CloudSee Drive OAuth issuer base, e.g. https://drive-oauth-uat.cloudsee.cloud)"),
  CLOUDSEE_API_BASE_URL: z.string().url("must be a valid URL").optional(),
  CLOUDSEE_DEFAULT_BUCKET: z.string().trim().min(1).optional(),
  CLOUDSEE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLOUDSEE_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).optional(),
});

/**
 * Load and validate the hosted-transport configuration from the environment.
 * Throws a CloudSeeError with an actionable, secret-free message when required
 * vars are missing. Mirrors `loadConfig` but for the multi-tenant HTTP server.
 */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const parsed = httpEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".")} ${i.message}`).join("\n");
    throw new CloudSeeError(
      `CloudSee Drive MCP server (hosted/HTTP mode) is not configured:\n${issues}\n\n` +
        `Set the required environment variables (see .env.example or the README).`,
      { code: "config" },
    );
  }
  const e = parsed.data;
  const oauthIssuer = e.CLOUDSEE_OAUTH_ISSUER.replace(/\/+$/, "");
  return {
    port: e.PORT ?? DEFAULT_PORT,
    publicUrl: e.MCP_PUBLIC_URL.replace(/\/+$/, ""),
    oauthIssuer,
    // The /v1 data plane is a DISTINCT host from the OAuth issuer (drive-api* vs drive-oauth*), so
    // fall back to the API default — NOT the issuer. Hosted deploys set this explicitly per stage.
    baseUrl: (e.CLOUDSEE_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: e.CLOUDSEE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    logLevel: e.CLOUDSEE_LOG_LEVEL ?? "info",
    defaultBucket: e.CLOUDSEE_DEFAULT_BUCKET,
  };
}
