import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  extractNextToken,
  readPageSizeHint,
  withPageSizeHint,
} from "../../src/client/pagination";
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

// CSD-667. The page size a walk should use is measured from the page just rendered, and it has to
// survive until the next call. The cursor is the only thing that travels between the two, it is
// minted by this connector and opaque to the model, so the measurement rides inside it rather than
// becoming a field of the tool contract.
describe("the adaptive page-size hint carried in a cursor", () => {
  it("round-trips the hint without disturbing the token it is attached to", () => {
    const cursor = withPageSizeHint(encodeCursor("nextPage", "abc123"), 42) as string;
    expect(readPageSizeHint(cursor)).toBe(42);
    expect(decodeCursor(cursor, "nextPage"), "the endpoint must still get its own token back").toBe("abc123");
  });

  it("keeps a structured token structured", () => {
    const searchAfter = [1757768351000, "Birds/", "abc"];
    const token = extractNextToken({ nextPage: searchAfter }, "nextPage");
    const cursor = withPageSizeHint(encodeCursor("nextPage", token?.value, token?.json), 7) as string;

    expect(decodeCursor(cursor, "nextPage")).toEqual(searchAfter);
    expect(readPageSizeHint(cursor)).toBe(7);
  });

  // The build now in production mints cursors with no hint, and they are live in open
  // conversations. Reading one must be a fallback to the caller's default, never an error.
  it("reads no hint from a cursor minted before the hint existed, without throwing", () => {
    expect(readPageSizeHint(encodeCursor("nextPage", "abc123"))).toBeUndefined();
    const legacy = Buffer.from(JSON.stringify({ d: "marker", v: "old-token" }), "utf8").toString("base64url");
    expect(readPageSizeHint(legacy)).toBeUndefined();
    expect(decodeCursor(legacy, "marker"), "the old cursor must still page").toBe("old-token");
  });

  it("reads no hint from anything this connector did not mint, and never throws", () => {
    expect(readPageSizeHint(undefined)).toBeUndefined();
    expect(readPageSizeHint("")).toBeUndefined();
    expect(readPageSizeHint("@@@not-valid@@@")).toBeUndefined();
    expect(readPageSizeHint("a-raw-server-token")).toBeUndefined();
  });

  it("ignores a hint that is not a whole page count", () => {
    for (const hint of [0, -1, 1.5, Number.NaN, "20", null, {}]) {
      const forged = Buffer.from(JSON.stringify({ d: "nextPage", v: "k", p: hint }), "utf8").toString("base64url");
      expect(readPageSizeHint(forged), `hint ${JSON.stringify(hint)} was accepted`).toBeUndefined();
    }
  });

  // A page size is an optimisation. It may never cost the caller the place in the walk that the
  // cursor represents, so anything that cannot carry a hint is handed back exactly as it arrived.
  it("returns the cursor untouched when the hint cannot be attached", () => {
    expect(withPageSizeHint(undefined, 20)).toBeUndefined();
    expect(withPageSizeHint("a-raw-server-token", 20)).toBe("a-raw-server-token");
    const cursor = encodeCursor("marker", "m1") as string;
    expect(withPageSizeHint(cursor, undefined)).toBe(cursor);
    expect(withPageSizeHint(cursor, 0)).toBe(cursor);
    expect(withPageSizeHint(cursor, 2.5)).toBe(cursor);
  });

  it("replaces a stale hint rather than stacking a second one", () => {
    const first = withPageSizeHint(encodeCursor("marker", "m1"), 40) as string;
    const second = withPageSizeHint(first, 8) as string;
    expect(readPageSizeHint(second)).toBe(8);
    expect(decodeCursor(second, "marker")).toBe("m1");
  });

  // CSD-667, the other half of compatibility. The tests above cover an OLD cursor read by this
  // build; during the release window the reverse also happens — a cursor minted here is handed to
  // a connector, or a hosted transport, that predates `p`. That build decodes the payload and
  // reads `d`, `v` and `j`; it tolerates the extra field only for as long as `p` stays ADDITIVE.
  // Asserting the payload's exact shape is what keeps it that way: renaming a field, or folding
  // the hint into `v`, would break every cursor open in a conversation on the older build.
  it("adds the hint as a new field and leaves the old payload byte-identical", () => {
    for (const [dialect, token, json] of [
      ["marker", "Photos/surf-012.jpg", false],
      ["nextPage", JSON.stringify([1757768351000, "Birds/", "abc"]), true],
      ["lastEvaluatedKey", JSON.stringify({ UserId: { S: "u-1" } }), true],
    ] as const) {
      const before = encodeCursor(dialect, token, json) as string;
      const after = withPageSizeHint(before, 42) as string;
      const beforePayload = JSON.parse(Buffer.from(before, "base64url").toString("utf8")) as Record<string, unknown>;
      const afterPayload = JSON.parse(Buffer.from(after, "base64url").toString("utf8")) as Record<string, unknown>;

      const { p, ...withoutTheHint } = afterPayload;
      expect(p, `${dialect}: the hint must be carried in \`p\``).toBe(42);
      expect(withoutTheHint, `${dialect}: the re-mint changed a field an older build reads`).toEqual(beforePayload);
      expect(Object.keys(afterPayload).filter((key) => !["d", "v", "j", "p"].includes(key))).toEqual([]);
      expect(decodeCursor(after, dialect), `${dialect}: the token itself must survive`).toEqual(
        json ? JSON.parse(token) : token,
      );
    }
  });
});
