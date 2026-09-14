import { AuthError, CloudSeeError } from "../errors";
import { logger } from "../logger";
import { VERSION } from "../version";
import type { Config } from "../config";
import { decodeCursor, encodeCursor, extractNextToken, type PaginationDialect } from "./pagination";

interface Envelope<T> {
  success?: boolean;
  data?: T;
  errorMessage?: string;
  code?: string;
}

export interface RequestOptions {
  retries?: number;
  signal?: AbortSignal;
}

export interface PagedResult<T> {
  data: T;
  nextCursor?: string;
}

interface ParsedResponse<T> {
  data: T;
  envelope: Record<string, unknown> | undefined;
}

const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 8_000;
const LOG_BODY_MAX = 4000; // cap request/response bodies in debug logs

/**
 * Typed wrapper over the CloudSee Drive `/v1/*` data plane. Every endpoint is an
 * RPC `POST /noun/verb` returning the platform `{ success, data, errorMessage,
 * code }` envelope. The client:
 *  - sets BOTH auth layers the data plane requires: the gateway usage-plan key
 *    (`X-Api-Key` = the public ApiKeyId) and the app credential
 *    (`X-Api-Key-Id` / `X-Api-Key-Secret`) — see the constructor,
 *  - retries 429/5xx with exponential backoff honoring `Retry-After` (the
 *    usage plan may throttle, so the server self-throttles),
 *  - unwraps the envelope and surfaces `success:false` as a CloudSeeError,
 *  - never logs the secret and redacts it from any error message.
 */
export class CloudSeeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly secret: string;
  private readonly headers: Record<string, string>;

  constructor(config: Config) {
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs;
    // Whichever credential material is present is the sensitive value to redact.
    this.secret = config.apiKeySecret ?? config.bearerToken ?? "";
    // Both /v1 auth modes send the GATEWAY key in `X-Api-Key` — its VALUE is the public
    // ApiKeyId (the usage-plan key is minted with `generateDistinctId:false`). Absent ⇒
    // the gateway 403s before the Lambda runs. Only the APP credential differs:
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Api-Key": config.apiKeyId,
      ...(config.bearerToken
        //  Hosted OAuth path: a bridge-signed access token carrying this ApiKeyId. The
        //  bridge verifies the signature (proof of consent) and needs NO secret.
        ? { Authorization: `Bearer ${config.bearerToken}` }
        //  Direct API-key path (stdio/env): the id+secret pair, Argon2id-verified.
        : {
            "X-Api-Key-Id": config.apiKeyId,
            "X-Api-Key-Secret": config.apiKeySecret ?? "",
          }),
      "User-Agent": `cloudsee-drive-mcp/${VERSION}`,
    };
  }

  /** POST a data-plane RPC endpoint (path WITHOUT `/v1`). Returns unwrapped `data`. */
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<T> {
    return (await this.request<T>(path, body, options)).data;
  }

  /** POST a paginated endpoint. Translates the opaque `cursor` to/from the
   *  endpoint's pagination dialect and returns a normalized `nextCursor`. The
   *  continuation token can sit at the envelope level (e.g. `/storage/recent`
   *  returns `nextToken` as a sibling of `data`) or inside `data` — check the
   *  envelope first, then `data`, so a token is never silently dropped. */
  async postPaged<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    dialect: PaginationDialect,
    cursor?: string,
    options: RequestOptions = {},
  ): Promise<PagedResult<T>> {
    const requestBody = { ...body };
    if (cursor) requestBody[dialect] = decodeCursor(cursor, dialect);
    const { data, envelope } = await this.request<T>(path, requestBody, options);
    const token = extractNextToken(envelope, dialect) ?? extractNextToken(data, dialect);
    return { data, nextCursor: encodeCursor(dialect, token?.value, token?.json) };
  }

  /** Run the request with retry/backoff, returning the unwrapped `data` together
   *  with the raw response envelope (needed for envelope-level pagination tokens). */
  private async request<T>(path: string, body: Record<string, unknown>, options: RequestOptions): Promise<ParsedResponse<T>> {
    const url = `${this.baseUrl}/v1${path}`;
    const retries = options.retries ?? DEFAULT_RETRIES;
    // Audit log of the outbound request (debug level). Headers — including the
    // API secret — are never logged; only the method, URL, and JSON body.
    logger.debug(`→ POST ${url} ${forLog(body)}`);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const response = await this.fetchOnce(url, path, body, options.signal);

      if (response.status === 401 || response.status === 403) {
        // Read the body before wording the error: app-level denials (e.g. the
        // ScopeChecker's `insufficient_scope`) also arrive as 403 and carry an
        // actionable {error:{code,message}} payload that must not be swallowed.
        const denialBody = await response.text().catch(() => "");
        logger.debug(`← ${response.status} POST /v1${path} ${forLog(denialBody)}`);
        const denial = parseDenial(denialBody);
        if (denial) {
          throw new AuthError(
            `CloudSee API denied the request (HTTP ${response.status}, ${denial.code}): ${this.redact(denial.message)}`,
            { status: response.status, code: denial.code },
          );
        }
        // No app payload — the denial came from the auth layer itself.
        //  • 403 = API Gateway rejected the usage-plan key (the `X-Api-Key` header). The
        //    id+secret may be perfectly valid; the gateway never reached the app.
        //  • 401 = the CloudSee Drive app rejected the id+secret (missing/invalid/expired).
        const message =
          response.status === 403
            ? "Access denied by the API gateway (HTTP 403). The API key is not recognized for this endpoint — " +
              "confirm CLOUDSEE_API_KEY_ID is correct, the key is enabled, and CLOUDSEE_API_BASE_URL points at the right host."
            : "Authentication failed (HTTP 401). Check CLOUDSEE_API_KEY_ID and CLOUDSEE_API_KEY_SECRET, and that the key is active and not expired.";
        throw new AuthError(message, { status: response.status });
      }

      if ((response.status === 429 || response.status >= 500) && attempt <= retries) {
        const waitMs = retryAfterMs(response.headers.get("retry-after")) ?? backoffMs(attempt);
        logger.warn(`HTTP ${response.status} from ${path}; retrying in ${waitMs}ms (attempt ${attempt}/${retries}).`);
        await sleep(waitMs);
        continue;
      }

      return await this.parse<T>(response, path);
    }
  }

  private async fetchOnce(
    url: string,
    path: string,
    body: Record<string, unknown>,
    external?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    if (external) external.addEventListener("abort", onAbort, { once: true });
    try {
      return await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = controller.signal.aborted ? `timed out after ${this.timeoutMs}ms` : this.redact(errMessage(err));
      throw new CloudSeeError(`Network error calling ${path}: ${reason}`, { code: "network", retryable: true });
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener("abort", onAbort);
    }
  }

  private async parse<T>(response: Response, path: string): Promise<ParsedResponse<T>> {
    const text = await response.text();
    // Audit log of the raw response (debug level) so the exact API payload — not
    // just what the model rendered — is reviewable in the server's stderr log.
    logger.debug(`← ${response.status} POST /v1${path} ${forLog(text)}`);
    let json: Envelope<T> | undefined;
    if (text) {
      try {
        json = JSON.parse(text) as Envelope<T>;
      } catch {
        throw new CloudSeeError(
          response.ok
            ? `CloudSee API returned a non-JSON response for ${path}.`
            : `CloudSee API returned HTTP ${response.status} for ${path}.`,
          { status: response.status, code: response.ok ? "bad_response" : "http_error" },
        );
      }
    }
    if (!response.ok) {
      const message = json?.errorMessage ?? `HTTP ${response.status}`;
      throw new CloudSeeError(`CloudSee API error for ${path}: ${this.redact(message)}`, {
        status: response.status,
        code: json?.code ?? "http_error",
      });
    }
    if (json && typeof json === "object" && json.success === false) {
      throw new CloudSeeError(this.redact(json.errorMessage || `Operation failed (${json.code ?? "unknown"}).`), {
        code: json.code ?? "operation_failed",
        status: response.status,
      });
    }
    const envelope = json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
    if (json && typeof json === "object" && "data" in json) return { data: json.data as T, envelope };
    return { data: (json ?? ({} as T)) as T, envelope };
  }

  private redact(text: string): string {
    return this.secret && text.includes(this.secret) ? text.split(this.secret).join("***") : text;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract an app-level denial from a 401/403 body: the CloudSee Drive `apiError`
 *  shape `{error:{code,message}}` or the platform envelope
 *  `{success:false,errorMessage,code}`. Returns undefined for non-JSON bodies and
 *  for the gateway's own `{"message":"Forbidden"}`, which carry no app detail. */
function parseDenial(text: string): { code: string; message: string } | undefined {
  if (!text) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object") return undefined;
  const record = json as Record<string, unknown>;
  if (record.error && typeof record.error === "object") {
    const err = record.error as Record<string, unknown>;
    if (typeof err.message === "string" && err.message) {
      return { code: typeof err.code === "string" && err.code ? err.code : "auth", message: err.message };
    }
  }
  if (record.success === false && typeof record.errorMessage === "string" && record.errorMessage) {
    return { code: typeof record.code === "string" && record.code ? record.code : "auth", message: record.errorMessage };
  }
  return undefined;
}

/** Render a request/response body for the debug audit log, bounded so a large
 *  listing can't flood stderr. (The logger redacts any registered secret.) */
function forLog(value: unknown): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > LOG_BODY_MAX ? `${s.slice(0, LOG_BODY_MAX)}… (+${s.length - LOG_BODY_MAX} more chars)` : s;
}

function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  // Full jitter over [ceiling/2, ceiling] to avoid thundering-herd retries.
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
