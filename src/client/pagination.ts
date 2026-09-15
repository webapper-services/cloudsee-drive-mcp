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
  /** How many items the next call should ask for, measured from the page this cursor came
   *  with (CSD-667). Absent on cursors minted before this field existed and on any cursor
   *  this connector did not mint, so every reader must have a default. */
  p?: number;
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

/** The cursor's payload, or undefined for anything this module did not mint. Deliberately
 *  silent: it serves the page-size hint, which is an optimisation — a cursor that is genuinely
 *  invalid must fail in `decodeCursor`, with its error, not here. */
function readPayload(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    return payload && typeof payload.v === "string" ? payload : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-mint a cursor carrying how many items the next call should ask for (CSD-667). The cursor is
 * the connector's own and opaque to the model, so the hint travels inside it instead of becoming
 * part of the tool contract.
 *
 * Any failure returns the cursor untouched: a page size is an optimisation, and it may never cost
 * the caller the place in the walk that the cursor represents.
 */
export function withPageSizeHint(cursor: string | undefined, pageSize: number | undefined): string | undefined {
  if (!cursor || pageSize === undefined || !Number.isInteger(pageSize) || pageSize < 1) return cursor;
  const payload = readPayload(cursor);
  if (!payload) return cursor;
  try {
    return Buffer.from(JSON.stringify({ ...payload, p: pageSize }), "utf8").toString("base64url");
  } catch {
    return cursor;
  }
}

/** The page-size hint a previous call minted into this cursor, or undefined when it carries none —
 *  a cursor from a build that predates the hint decodes to the caller's default, never to an error. */
export function readPageSizeHint(cursor: string | undefined): number | undefined {
  const hint = readPayload(cursor)?.p;
  return typeof hint === "number" && Number.isInteger(hint) && hint >= 1 ? hint : undefined;
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
