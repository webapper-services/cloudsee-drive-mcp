import { describe, it, expect } from "vitest";
import { formatMetadataUpdate, summarize, summarizeListing, withCursor } from "../../src/tools/format";

/** A listing envelope shaped like /storage/list's: bulky unprojected index documents first,
 *  the fields that describe the result set last. 21 items renders to ~25k characters. */
function bulkyListing(totalItems: number): Record<string, unknown> {
  const items = Array.from({ length: totalItems }, (_, index) => ({
    Name: `surf-${String(index).padStart(3, "0")}.jpg`,
    Key: `Photos/surf-${String(index).padStart(3, "0")}.jpg`,
    Size: 259578,
    StorageId: `937896d1f42416222e53d07baa80eab19af321d8ff6eb1a056da08b0f7abb5${String(index).padStart(2, "0")}`,
    Metadata: Object.fromEntries(
      Array.from({ length: 24 }, (_, field) => [`IndexField${field}`, "N/A placeholder written by the indexer"]),
    ),
  }));
  return { items, totalItems, totalPages: 11, nextPage: null };
}

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

// CSD-662 F2. A listing serialises `items` first and `totalItems`/`totalPages` last, so
// capping the rendered TEXT severs exactly the numbers that would reveal the truncation:
// 7 items of 21 arrived looking like a complete listing.
describe("summarizeListing", () => {
  it("keeps totalItems and states how many items were shown when the page cannot be rendered whole", () => {
    const listing = bulkyListing(21);
    expect(JSON.stringify(listing, null, 2).length).toBeGreaterThan(8_000); // the payload really is oversized

    const out = summarizeListing(listing);
    expect(out).toContain('"totalItems": 21');
    expect(out).toContain('"totalPages": 11');
    expect(out).toMatch(/"shown": \d+/);
    expect(out).toContain("more item(s) omitted");
    expect(out.length).toBeLessThanOrEqual(8_000);
  });

  it("is what the character cut cost: summarize loses the totals on the same payload", () => {
    const listing = bulkyListing(21);
    expect(summarize(listing)).not.toContain('"totalItems": 21');
    expect(summarize(listing)).toContain("output truncated");
  });

  it("renders every item and an honest shown count when the page fits", () => {
    const out = summarizeListing({ items: [{ Name: "a.txt" }, { Name: "b.txt" }], totalItems: 2, totalPages: 1 });
    expect(out).toContain('"totalItems": 2');
    expect(out).toContain('"shown": 2');
    expect(out).toContain("a.txt");
    expect(out).toContain("b.txt");
    expect(out).not.toContain("omitted");
  });

  it("falls back to summarize for a bare array — /storage/recent has no items envelope", () => {
    const recent = [{ Name: "renamed-by-claude.txt" }, { Name: "mcp-upload-test.txt" }];
    expect(summarizeListing(recent)).toBe(summarize(recent));
  });

  it("falls back to summarize for payloads that are not listings", () => {
    expect(summarizeListing({ ok: true })).toBe(summarize({ ok: true }));
    expect(summarizeListing(null)).toBe(summarize(null));
    expect(summarizeListing(undefined)).toBe(summarize(undefined));
    expect(summarizeListing({ items: "not-an-array" })).toBe(summarize({ items: "not-an-array" }));
  });

  it("stays inside the cap even when a single scalar field is oversized", () => {
    const out = summarizeListing({ items: [{ Name: "a.txt" }], totalItems: 1, note: "x".repeat(20_000) });
    expect(out.length).toBeLessThanOrEqual(8_000 + 100); // the text cut plus its notice
    expect(out).toContain("output truncated");
  });
});

describe("formatMetadataUpdate (CSD-664)", () => {
  const mergeOutcome = {
    updated: 1,
    mode: "merge",
    metadata: { changed: ["project"], cleared: ["description"], kept: ["category"] },
    tags: { set: ["Age"], removed: [], kept: ["Department", "Breed"], total: 3 },
  };

  it("enumerates what a merge changed, cleared and kept", () => {
    const text = formatMetadataUpdate(mergeOutcome, "937896d1");
    expect(text).toBe(
      'Updated metadata on storage id "937896d1" (mode: merge — anything you did not send was kept).\n' +
        "Metadata — changed: project; cleared: description; kept: category.\n" +
        "Tags — set: Age; kept: Department, Breed; removed: none. 3 tag(s) now on the object.",
    );
  });

  it("says what a replace destroyed", () => {
    const text = formatMetadataUpdate(
      {
        updated: 1,
        mode: "replace",
        metadata: { changed: ["category"], cleared: ["project", "description"], kept: [] },
        tags: { set: ["Age"], removed: ["Department", "Breed"], kept: [], total: 1 },
      },
      "937896d1",
    );
    expect(text).toContain("mode: replace — everything you did not send was cleared");
    expect(text).toContain("cleared: project, description; kept: none.");
    expect(text).toContain("removed: Department, Breed. 1 tag(s) now on the object.");
  });

  it("falls back to the legacy text for the bare update count a pre-CSD-664 backend returns", () => {
    expect(formatMetadataUpdate(1, "937896d1")).toBe('Updated metadata on storage id "937896d1".\n\n1');
  });

  it("falls back for any payload that is not the outcome object", () => {
    const cases: unknown[] = [
      null,
      undefined,
      "ok",
      [mergeOutcome],
      { ...mergeOutcome, mode: "patch" },
      { ...mergeOutcome, metadata: { changed: ["project"], cleared: ["description"] } },
      { ...mergeOutcome, tags: { set: ["Age"], removed: [], kept: [], total: "3" } },
      { ...mergeOutcome, metadata: { changed: [1], cleared: [], kept: [] } },
    ];
    for (const data of cases) {
      expect(formatMetadataUpdate(data, "937896d1")).toBe(`Updated metadata on storage id "937896d1".\n\n${summarize(data)}`);
    }
  });
});
