import { describe, it, expect } from "vitest";
import { summarize, withCursor } from "../../src/tools/format";

describe("summarize", () => {
  // JSON.stringify RETURNS undefined for these rather than throwing, so a naive try/catch does
  // not save you and the next string operation crashes. This surfaced as an upload reporting
  // "failed" with no useful reason, when the endpoint had simply answered with no body.
  it("renders values JSON.stringify cannot represent, instead of throwing", () => {
    expect(() => summarize(undefined)).not.toThrow();
    expect(summarize(undefined)).toBe("undefined");
    expect(() => summarize(() => "x")).not.toThrow();
  });

  it("renders ordinary payloads as indented JSON", () => {
    expect(summarize({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(summarize(null)).toBe("null");
  });

  it("caps long arrays and says how many were dropped", () => {
    const out = summarize(Array.from({ length: 150 }, (_, i) => i), { maxItems: 100 });
    expect(out).toContain("50 more item(s) omitted");
  });

  it("truncates oversized output rather than flooding the caller", () => {
    const out = summarize({ blob: "x".repeat(20_000) }, { maxChars: 500 });
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("output truncated");
  });

  it("appends a continuation hint only when there is another page", () => {
    expect(withCursor("body", "abc")).toContain('cursor="abc"');
    expect(withCursor("body", undefined)).toBe("body");
  });
});
