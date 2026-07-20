// Structured logging that writes to **stderr only**. stdout is reserved for the
// MCP stdio transport — anything written there corrupts the protocol stream.
// All output is passed through secret redaction as a defense-in-depth backstop;
// the real rule is to never hand the API secret to the logger in the first place.

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_WEIGHT: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel: LogLevel = "info";
let secrets: string[] = [];

export function configureLogger(options: { level?: LogLevel; redact?: string[] }): void {
  if (options.level) currentLevel = options.level;
  if (options.redact) {
    secrets = options.redact.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
}

/** Replace any registered secret with `***` anywhere it appears in `text`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("***");
  }
  return out;
}

function stringify(meta: unknown): string {
  if (meta === undefined) return "";
  if (typeof meta === "string") return meta;
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[currentLevel]) return;
  const suffix = meta === undefined ? "" : ` ${stringify(meta)}`;
  process.stderr.write(`[cloudsee-drive-mcp] ${level.toUpperCase()}: ${redactSecrets(message + suffix)}\n`);
}

export const logger = {
  error: (message: string, meta?: unknown): void => emit("error", message, meta),
  warn: (message: string, meta?: unknown): void => emit("warn", message, meta),
  info: (message: string, meta?: unknown): void => emit("info", message, meta),
  debug: (message: string, meta?: unknown): void => emit("debug", message, meta),
};
