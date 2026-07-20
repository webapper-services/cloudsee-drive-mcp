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
    expect(extractNextToken({ nextPage: "p2" }, "nextPage")).toBe("p2");
    expect(extractNextToken({ nextPageToken: "t2" }, "nextPage")).toBe("t2");
    expect(extractNextToken({ marker: "m2" }, "marker")).toBe("m2");
    expect(extractNextToken({}, "nextPage")).toBeUndefined();
    expect(extractNextToken(null, "nextPage")).toBeUndefined();
  });
});
