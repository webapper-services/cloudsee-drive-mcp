export interface CloudSeeErrorOptions {
  code?: string;
  status?: number;
  retryable?: boolean;
}

/** Error raised for any failed CloudSee API interaction. Messages are redacted
 *  by the client before construction and must never contain the API secret. */
export class CloudSeeError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: CloudSeeErrorOptions = {}) {
    super(message);
    this.name = "CloudSeeError";
    this.code = options.code ?? "error";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/** Authentication/authorization failure (HTTP 401/403). Terminal — never retried. */
export class AuthError extends CloudSeeError {
  constructor(message: string, options: CloudSeeErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "auth" });
    this.name = "AuthError";
  }
}
