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
  /** The token was JSON-encoded because the endpoint's own token is not a string
   *  (OpenSearch `search_after` is an array, DynamoDB's `lastEvaluatedKey` an object).
   *  Absent on cursors minted before this field existed — those decode as strings. */
  j?: true;
}

/** A continuation token lifted off a response, carrying whether it had to be
 *  JSON-encoded so `decodeCursor` can hand the endpoint back its original shape. */
export interface NextToken {
  value: string;
  json: boolean;
}

export function encodeCursor(dialect: PaginationDialect, value: string | null | undefined, json = false): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const payload: CursorPayload = { d: dialect, v: String(value) };
  if (json) payload.j = true;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Returns the token in the shape the endpoint minted it: a string for the string
 *  dialects, the decoded array/object for the ones whose token is structured. */
export function decodeCursor(cursor: string, expected: PaginationDialect): unknown {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw new CloudSeeError("Invalid pagination cursor.", { code: "bad_cursor" });
  }
  if (!payload || typeof payload.v !== "string" || payload.d !== expected) {
    throw new CloudSeeError("Pagination cursor is not valid for this operation.", { code: "bad_cursor" });
  }
  if (!payload.j) return payload.v;
  try {
    return JSON.parse(payload.v);
  } catch {
    throw new CloudSeeError("Invalid pagination cursor.", { code: "bad_cursor" });
  }
}

const RESPONSE_FIELDS = ["nextPage", "nextPageToken", "marker", "lastEvaluatedKey", "pageToken", "nextToken"];

/**
 * Pull the raw continuation token out of a response envelope's `data`, tolerant
 * of the exact field name (which varies by endpoint and isn't guaranteed by the
 * RPC contract). Prefers the operation's own dialect field, then known aliases.
 * A non-string token is JSON-encoded and flagged, so the cursor keeps its shape.
 */
export function extractNextToken(data: unknown, dialect: PaginationDialect): NextToken | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  for (const field of [dialect, ...RESPONSE_FIELDS]) {
    const value = record[field];
    if (typeof value === "string" && value !== "") return { value, json: false };
    if (value && typeof value === "object") {
      try {
        return { value: JSON.stringify(value), json: true };
      } catch {
        /* ignore non-serializable */
      }
    }
  }
  return undefined;
}
