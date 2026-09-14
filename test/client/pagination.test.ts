import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, extractNextToken } from "../../src/client/pagination";
import { CloudSeeError } from "../../src/errors";

describe("pagination cursor codec", () => {
  it("round-trips a value through encode/decode", () => {
    const cursor = encodeCursor("nextPage", "abc123");
    expect(typeof cursor).toBe("string");
    expect(decodeCursor(cursor as string, "nextPage")).toBe("abc123");
  });

  it("returns undefined for empty/missing values", () => {
    expect(encodeCursor("nextPage", "")).toBeUndefined();
    expect(encodeCursor("marker", null)).toBeUndefined();
    expect(encodeCursor("marker", undefined)).toBeUndefined();
  });

  it("rejects a cursor minted for a different operation's dialect", () => {
    const cursor = encodeCursor("marker", "m1") as string;
    expect(() => decodeCursor(cursor, "nextPage")).toThrow(CloudSeeError);
  });

  it("rejects a malformed cursor", () => {
    expect(() => decodeCursor("@@@not-valid@@@", "nextPage")).toThrow(CloudSeeError);
  });

  it("extracts the next token tolerant of the response field name", () => {
    expect(extractNextToken({ nextPage: "p2" }, "nextPage")).toEqual({ value: "p2", json: false });
    expect(extractNextToken({ nextPageToken: "t2" }, "nextPage")).toEqual({ value: "t2", json: false });
    expect(extractNextToken({ marker: "m2" }, "marker")).toEqual({ value: "m2", json: false });
    expect(extractNextToken({}, "nextPage")).toBeUndefined();
    expect(extractNextToken(null, "nextPage")).toBeUndefined();
  });

  // CSD-662 F3a/F3b. /storage/list's token is OpenSearch's `search_after` sort values — an
  // ARRAY. Flattening it to a string made the engine answer
  // "Unknown key for a VALUE_STRING in [search_after]", which reached the caller as the
  // generic APP_ERROR sentence. The cursor must hand the endpoint back the shape it minted.
  it("round-trips an OpenSearch search_after array token as an array, not a string", () => {
    const searchAfter = [1757768351000, "Birds/", "abc"];
    const token = extractNextToken({ nextPage: searchAfter }, "nextPage");
    expect(token).toEqual({ value: JSON.stringify(searchAfter), json: true });

    const cursor = encodeCursor("nextPage", token?.value, token?.json) as string;
    const decoded = decodeCursor(cursor, "nextPage");
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toEqual(searchAfter);
  });

  // CSD-662 F3c, second fault: /storage/recent's token is a DynamoDB key OBJECT, so even once
  // the request field name is right, a stringified token would still be rejected downstream.
  it("round-trips a DynamoDB lastEvaluatedKey object token as an object", () => {
    const lastEvaluatedKey = { StorageId: "a", Email: "b" };
    const token = extractNextToken({ nextToken: lastEvaluatedKey }, "nextPage");
    expect(token).toEqual({ value: JSON.stringify(lastEvaluatedKey), json: true });

    const cursor = encodeCursor("nextPage", token?.value, token?.json) as string;
    const decoded = decodeCursor(cursor, "nextPage");
    expect(decoded).toEqual(lastEvaluatedKey);
    expect(Array.isArray(decoded)).toBe(false);
    expect(typeof decoded).toBe("object");
  });

  // Cursors minted by 2.0.1 carry no `j` flag and are still live in open conversations.
  it("decodes a cursor minted before the JSON flag existed as a plain string", () => {
    const legacy = Buffer.from(JSON.stringify({ d: "marker", v: "old-token" }), "utf8").toString("base64url");
    expect(decodeCursor(legacy, "marker")).toBe("old-token");
  });

  it("keeps a string token byte-identical, without the JSON flag", () => {
    const token = extractNextToken({ marker: "1/3H4sIAAA=" }, "marker");
    const cursor = encodeCursor("marker", token?.value, token?.json) as string;
    expect(decodeCursor(cursor, "marker")).toBe("1/3H4sIAAA=");
  });

  it("rejects a JSON-flagged cursor whose payload is not parseable", () => {
    const corrupt = Buffer.from(JSON.stringify({ d: "nextPage", v: "[1757768351000,", j: true }), "utf8").toString(
      "base64url",
    );
    expect(() => decodeCursor(corrupt, "nextPage")).toThrow(CloudSeeError);
  });
});
