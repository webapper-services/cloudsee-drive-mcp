import { CloudSeeError } from "../errors";

// The data plane uses five different pagination param names across endpoint
// families (C10): `nextPage`, `marker`, `lastEvaluatedKey`, `pageToken`,
// `nextToken`. Tools expose a single opaque `cursor`; this module encodes the
// dialect + raw token into that cursor and decodes it back, so a cursor minted
// for one operation can't be misapplied to another.

export type PaginationDialect = "nextPage" | "marker" | "lastEvaluatedKey" | "pageToken" | "nextToken";

interface CursorPayload {
  d: PaginationDialect;
  v: string;
}

export function encodeCursor(dialect: PaginationDialect, value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const payload: CursorPayload = { d: dialect, v: String(value) };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, expected: PaginationDialect): string {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw new CloudSeeError("Invalid pagination cursor.", { code: "bad_cursor" });
  }
  if (!payload || typeof payload.v !== "string" || payload.d !== expected) {
    throw new CloudSeeError("Pagination cursor is not valid for this operation.", { code: "bad_cursor" });
  }
  return payload.v;
}

const RESPONSE_FIELDS = ["nextPage", "nextPageToken", "marker", "lastEvaluatedKey", "pageToken", "nextToken"];

/**
 * Pull the raw continuation token out of a response envelope's `data`, tolerant
 * of the exact field name (which varies by endpoint and isn't guaranteed by the
 * RPC contract). Prefers the operation's own dialect field, then known aliases.
 */
export function extractNextToken(data: unknown, dialect: PaginationDialect): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  for (const field of [dialect, ...RESPONSE_FIELDS]) {
    const value = record[field];
    if (typeof value === "string" && value !== "") return value;
    if (value && typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        /* ignore non-serializable */
      }
    }
  }
  return undefined;
}
