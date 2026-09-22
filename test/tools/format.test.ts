import { describe, it, expect } from "vitest";
import {
  ABBREVIATED_ITEM_NOTICE,
  FIRST_PAGE_ITEMS,
  SMALLER_PAGE_RETRY_NOTICE,
  TRUNCATED_SCALAR_NOTICE,
  formatMetadataUpdate,
  summarize,
  summarizeListing,
  withCursor,
} from "../../src/tools/format";

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
  // CSD-667 C5, replacement 1 of 2. This case used to assert the page carried
  // "… N more item(s) omitted to fit the output budget — paginate for the rest". That wording
  // encoded the defect: paginating is exactly what skipped the omitted items. Its intent is
  // kept — the totals survive and `shown` is honest — and the expectation is now that no item
  // is dropped at all: the ones that do not fit are published as identity-only stubs.
  it("keeps totalItems and represents every item of a page that cannot be rendered whole", () => {
    const listing = bulkyListing(21);
    expect(JSON.stringify(listing, null, 2).length).toBeGreaterThan(8_000); // the payload really is oversized

    const render = summarizeListing(listing);
    expect(render.text).toContain('"totalItems": 21');
    expect(render.text).toContain('"totalPages": 11');
    expect(render.text).toContain('"shown": 21');
    expect(render.text).not.toContain("paginate for the rest");
    expect(render.complete).toBe(true);
    expect(render.text.length).toBeLessThanOrEqual(8_000);
    expect(() => JSON.parse(render.text)).not.toThrow();
  });

  it("is what the character cut cost: summarize loses the totals on the same payload", () => {
    const listing = bulkyListing(21);
    expect(summarize(listing)).not.toContain('"totalItems": 21');
    expect(summarize(listing)).toContain("output truncated");
  });

  it("renders every item and an honest shown count when the page fits", () => {
    const render = summarizeListing({ items: [{ Name: "a.txt" }, { Name: "b.txt" }], totalItems: 2, totalPages: 1 });
    expect(render.text).toContain('"totalItems": 2');
    expect(render.text).toContain('"shown": 2');
    expect(render.text).toContain("a.txt");
    expect(render.text).toContain("b.txt");
    expect(render.text).not.toContain("omitted");
    expect(render.text).not.toContain("abbreviated");
    expect(render.complete).toBe(true);
  });

  // CSD-667 C5, replacement 2 of 2. This case used to assert
  // `summarizeListing(array) === summarize(array)` — the bare-array path falling through to the
  // raw character cut, which is how list_files rendered 11 of 700 objects and ended mid-key.
  // A bare array is now a listing; the count the envelope would have carried travels in
  // `totalReturned`, and the array's numeric indices must never become envelope scalars.
  it("renders a bare array as a listing — /storage/recent and /storage/bucket/files have no items envelope", () => {
    const recent = Array.from({ length: 700 }, (_, index) => ({
      Name: `object-${index}.bin`,
      Key: `Archive/object-${index}.bin`,
      StorageId: `os-${index}`,
      Metadata: Object.fromEntries(Array.from({ length: 12 }, (_, f) => [`Field${f}`, "N/A placeholder"])),
    }));

    const render = summarizeListing(recent);
    expect(render.text).not.toBe(summarize(recent));

    const view = JSON.parse(render.text) as Record<string, unknown>;
    expect(view.totalReturned).toBe(700); // the honest stand-in for the totalItems an array cannot carry
    expect(view.shown).toBeGreaterThanOrEqual(1);
    expect(view["0"]).toBeUndefined(); // the array's indices must not become envelope scalars
    // 700 objects cannot fit any budget, so this page is honestly incomplete and read.ts
    // withholds the cursor. The outbound clamp is what keeps a real page from reaching here.
    expect(render.complete).toBe(false);
    expect(render.text).toContain(SMALLER_PAGE_RETRY_NOTICE);
  });

  it("falls back to summarize for payloads that are not listings", () => {
    expect(summarizeListing({ ok: true }).text).toBe(summarize({ ok: true }));
    expect(summarizeListing(null).text).toBe(summarize(null));
    expect(summarizeListing(undefined).text).toBe(summarize(undefined));
    expect(summarizeListing({ items: "not-an-array" }).text).toBe(summarize({ items: "not-an-array" }));
  });

  // CSD-667, replacement 3. This case used to assert that an oversized envelope scalar drove the
  // whole render into the raw character cut — and that cut destroyed the items with it: through
  // the real search_files tool, an ~8 000-character `query` echoed back by /storage/list produced
  // 0 of 20 identities, no cursor and JSON that does not parse, while 40 items were still behind
  // it. The envelope describes the result set; it may not consume the budget the result set needs.
  it("bounds an oversized envelope scalar visibly, instead of cutting the page that carries it", () => {
    const render = summarizeListing({ items: [{ Name: "a.txt", Key: "a.txt" }], totalItems: 1, note: "x".repeat(20_000) });

    const view = JSON.parse(render.text) as { note: string; totalItems: number; shown: number };
    expect(view.note).toContain(TRUNCATED_SCALAR_NOTICE); // cut, but never silently
    expect(view.note.length).toBeLessThan(300);
    expect(view.totalItems).toBe(1); // the numbers that describe the result set are never cut
    expect(view.shown).toBe(1);
    expect(render.text).not.toContain("output truncated");
    expect(render.complete).toBe(true); // the page is whole, so the cursor may advance past it
  });
});

// CSD-667 §4. Detail omitted from a listing is deferred — get_file_metadata returns it for one
// named object. Existence omitted is lost: a caller cannot ask for a key it was never told
// about. So identity is published even for an item that cannot be rendered in full.
describe("summarizeListing — the abbreviated fallback", () => {
  const oversizedItem = {
    Name: "quarterly-report-2026.xlsx",
    Key: "Finance/2026/Q3/quarterly-report-2026.xlsx",
    StorageId: "8f3c1d5e-2b44-4d51-9c8a-0d5e6f7a8b9c",
    Size: 8_421_904,
    Description: "x".repeat(20_000),
  };

  it("publishes Name, Key, StorageId and the fixed marker for an item too large to render", () => {
    const render = summarizeListing({
      items: [oversizedItem, { Name: "b.txt", Key: "b.txt", StorageId: "os-2", Size: 12 }],
      totalItems: 2,
      totalPages: 1,
    });

    const view = JSON.parse(render.text) as { shown: number; abbreviated: number; items: Record<string, unknown>[] };
    expect(view.shown).toBe(2);
    expect(view.abbreviated).toBeGreaterThanOrEqual(1);
    expect(view.items[0]).toEqual({
      Name: oversizedItem.Name,
      Key: oversizedItem.Key,
      StorageId: oversizedItem.StorageId,
      Abbreviated: ABBREVIATED_ITEM_NOTICE,
    });
    // The page is complete — every item is represented — so the cursor may advance past it.
    expect(render.complete).toBe(true);
  });

  it("never truncates the identity it publishes", () => {
    const longKey = `Finance/${"deeply-nested-folder/".repeat(40)}report.xlsx`;
    const render = summarizeListing({ items: [{ ...oversizedItem, Key: longKey }], totalItems: 1 });
    expect(render.text).toContain(longKey);
  });

  it("falls back to Path when the item carries no Key", () => {
    const render = summarizeListing({
      items: [{ Name: "a.txt", Path: "Reports/a.txt", Description: "x".repeat(20_000) }],
      totalItems: 1,
    });
    const view = JSON.parse(render.text) as { items: Record<string, unknown>[] };
    expect(view.items[0]).toEqual({ Name: "a.txt", Key: "Reports/a.txt", Abbreviated: ABBREVIATED_ITEM_NOTICE });
  });

  it("renders at least one item and reports incomplete when not even the identities fit", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      Name: `object-${index}.bin`,
      Key: `Archive/${"segment/".repeat(10)}object-${index}.bin`,
      StorageId: `os-${index}`,
      Description: "x".repeat(4_000),
    }));

    const render = summarizeListing({ items, totalItems: 6 }, { maxChars: 900 });
    const view = JSON.parse(render.text) as { shown: number; items: unknown[] };
    expect(view.shown).toBeGreaterThanOrEqual(1);
    expect(view.shown).toBeLessThan(items.length);
    expect(render.text).toContain(SMALLER_PAGE_RETRY_NOTICE);
    expect(render.text).not.toContain("paginate for the rest");
    // Incomplete is the whole point: read.ts withholds the cursor, so the items left behind
    // stay reachable by re-asking at the same cursor with a smaller page size.
    expect(render.complete).toBe(false);
  });

  // CSD-667 §4.3, the other half of the always-render-one rule. The rule concedes a bounded
  // overrun, and the bound is "the first item of the page" — an envelope that could add to it
  // would turn a stated concession into an unbounded one. `ENVELOPE_BUDGET_SHARE` is what makes
  // that claim true, so it is asserted against an envelope built to break it: the same oversized
  // first item, once with a bare envelope and once with 300 scalars of server noise, must overrun
  // by the SAME amount, and the noise must be reported in `droppedFields` rather than rendered.
  it("overruns the budget by the first item only — never by the envelope", () => {
    const page = { items: [oversizedItem, { Name: "b.txt", Key: "b.txt" }], totalItems: 2, totalPages: 1 };
    const noise = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`echoedField${index}`, index]));

    const bare = summarizeListing(page, { maxChars: 120 });
    const noisy = summarizeListing({ ...page, ...noise }, { maxChars: 120 });
    const view = JSON.parse(noisy.text) as { shown: number; totalItems: number; droppedFields?: number };

    expect(view.shown).toBe(1);
    expect(view.totalItems, "the signal fields are exempt from the budget, whatever the noise").toBe(2);
    expect(view.droppedFields, "the noise must be counted, not rendered").toBeGreaterThan(0);
    // 1/8 of a 120-character budget is 15 — too little for even one noise entry — so not one of
    // the 300 may be rendered. What the noisy render may add is the one-line `droppedFields`
    // report, which is written after the budget and costs ~24 characters. Anything beyond that
    // would be the envelope taking a share of an overrun the item alone is supposed to own.
    expect(Object.keys(view).filter((key) => key.startsWith("echoedField"))).toHaveLength(0);
    expect(noisy.text.length - bare.text.length, "the envelope spent budget it does not have").toBeLessThanOrEqual(32);
  });

  it("renders the first item of a page even when its identity alone overruns the budget", () => {
    const render = summarizeListing({ items: [oversizedItem, { Name: "b.txt", Key: "b.txt" }] }, { maxChars: 120 });
    const view = JSON.parse(render.text) as { shown: number };
    expect(view.shown).toBe(1); // never 0 — a page that renders nothing blocks the walk for good
    expect(render.text).toContain(oversizedItem.Key);
    expect(render.complete).toBe(false);
  });

  // CSD-667. The always-render-one rule asked for one item of a page that holds none, so a page
  // that rendered COMPLETELY reported itself incomplete — and read.ts withholds the cursor on that
  // report. With no item left behind there is no sentinel either, so the caller got neither a
  // cursor nor a retry instruction while the server still had pages: a dead end (clauses 1 and 3).
  it("reports an empty page complete — there is no item left behind to withhold a cursor for", () => {
    const render = summarizeListing({ items: [], totalItems: 0 }, { maxChars: 5 });
    const view = JSON.parse(render.text) as { shown: number; items: unknown[] };
    expect(view.shown).toBe(0);
    expect(view.items).toEqual([]);
    expect(render.text).not.toContain(SMALLER_PAGE_RETRY_NOTICE);
    expect(render.complete).toBe(true);
  });
});

// CSD-667 §4.3. An index document is ~2 300 characters of which the indexer's own bookkeeping is
// the bulk; a listing is read for the fields below. The projection is what makes a full page of
// whole items fit at all — and it must never leak into `summarize`, which 13 non-listing tools use.
describe("summarizeListing — the listing item projection", () => {
  const indexDocument = {
    Name: "surf-001.jpg",
    Key: "Photos/surf-001.jpg",
    Size: 259578,
    LastModified: "2026-08-14T03:21:55.000Z",
    IsFolder: false,
    StorageId: "937896d1f42416222e53d07baa80eab1",
    StorageClass: "GLACIER",
    Status: "Ready",
    Project: "Marketing",
    Category: "",
    Description: "",
    RestoreStatus: "",
    Metadata: Object.fromEntries(Array.from({ length: 24 }, (_, f) => [`IndexField${f}`, "N/A placeholder"])),
    ETag: '"e4d909c290d0fb1ca068ffaddf22cbd0"',
    ChecksumAlgorithm: ["CRC32"],
    _id: "os-0001",
    ObjectUUID: "3f1c9a7e-2b44-4d51-9c8a-0d5e6f7a8b9c",
    SanitizedKey: "photos/surf-001.jpg",
    ParentPaths: ["", "Photos/"],
  };

  it("keeps the fields a listing is read for and drops the indexer's bookkeeping", () => {
    const render = summarizeListing({ items: [indexDocument], totalItems: 1 });
    const view = JSON.parse(render.text) as { items: Record<string, unknown>[] };
    const item = view.items[0]!;

    expect(Object.keys(item)).toEqual([
      "Name",
      "Key",
      "Size",
      "LastModified",
      "IsFolder",
      "StorageId",
      "StorageClass",
      "Status",
      "Project",
    ]);
    expect(item.StorageClass).toBe("GLACIER"); // a model needs this to know a file is not downloadable
    expect(item.Project).toBe("Marketing"); // kept because it is non-empty
    expect(item.Category).toBeUndefined(); // dropped because it is empty
  });

  it("falls back to Path when the item carries no Key", () => {
    const render = summarizeListing({ items: [{ Name: "a.txt", Path: "Reports/a.txt", Size: 1 }], totalItems: 1 });
    const view = JSON.parse(render.text) as { items: Record<string, unknown>[] };
    expect(view.items[0]).toEqual({ Name: "a.txt", Key: "Reports/a.txt", Size: 1 });
  });

  // CSD-672. `/storage/recent` rows are the one listing payload whose timestamp is not called
  // `LastModified`, so the allow-list matched nothing and `recent_files` rendered Name/Key/StorageId
  // with no date at all. The row below is the shape `RecentDto` puts on the wire.
  it("publishes a /storage/recent row's UpdatedAt as LastModified", () => {
    const recentRow = {
      Email: "daniela@webapper.net",
      Bucket: "csd-app-verify",
      StorageId: 1789767981603,
      Name: "Screenshot 2026-09-15 at 2.38.21 PM.png",
      Parent: "App-Verify-2026-09-15/",
      UpdatedAt: "2026-09-18T04:12:07.881Z",
      Key: "App-Verify-2026-09-15/Screenshot 2026-09-15 at 2.38.21 PM.png",
    };

    const render = summarizeListing([recentRow]);
    const view = JSON.parse(render.text) as { items: Record<string, unknown>[] };

    expect(view.items[0]).toEqual({
      Name: "Screenshot 2026-09-15 at 2.38.21 PM.png",
      Key: "App-Verify-2026-09-15/Screenshot 2026-09-15 at 2.38.21 PM.png",
      LastModified: "2026-09-18T04:12:07.881Z",
      StorageId: 1789767981603,
    });
  });

  // An indexed document carries both: `LastModified` is the object's own, `UpdatedAt` is the index
  // write time. Preference order is the only way the CSD-672 alias could damage browse_folder and
  // search_files, so the projected key list must stay exactly what the test above pins.
  it("prefers an indexed document's own LastModified over its UpdatedAt", () => {
    const render = summarizeListing({
      items: [{ ...indexDocument, UpdatedAt: "2026-11-08T10:57:08.232Z" }],
      totalItems: 1,
    });
    const view = JSON.parse(render.text) as { items: Record<string, unknown>[] };
    const item = view.items[0]!;

    expect(item.LastModified).toBe("2026-08-14T03:21:55.000Z");
    expect(Object.keys(item)).toEqual([
      "Name",
      "Key",
      "Size",
      "LastModified",
      "IsFolder",
      "StorageId",
      "StorageClass",
      "Status",
      "Project",
    ]);
    expect(render.text).not.toContain("UpdatedAt");
  });

  it("does not leak into summarize — every non-listing tool still renders its payload whole", () => {
    const rendered = summarize(indexDocument);
    expect(rendered).toContain("ObjectUUID");
    expect(rendered).toContain("SanitizedKey");
    expect(rendered).toContain("ChecksumAlgorithm");
  });

  // The page size is taken from the constant rather than written out: it was 20 until the clamp
  // was recalibrated against realistic key lengths, and a full page must mean whatever the current
  // calibration says it means. `listing-walk.test.ts` pins the calibration itself.
  it("renders a full page of projected documents whole — no stubs, no sentinel", () => {
    const items = Array.from({ length: FIRST_PAGE_ITEMS }, (_, index) => ({
      ...indexDocument,
      Key: `Photos/surf-${index}.jpg`,
    }));
    const render = summarizeListing({ items, totalItems: FIRST_PAGE_ITEMS, totalPages: 1 });

    expect(render.text).toContain(`"shown": ${FIRST_PAGE_ITEMS}`);
    expect(render.text).not.toContain("abbreviated");
    expect(render.text).not.toContain(SMALLER_PAGE_RETRY_NOTICE);
    expect(render.complete).toBe(true);
  });

  // The halving loop it replaces used 5 398 of the 8 000 characters available before giving up on
  // an item — it halved past the largest count that fits instead of filling to it, and every
  // overshoot was an item silently dropped.
  it("fills the budget rather than halving past it", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...indexDocument,
      Key: `Photos/surf-${index}.jpg`,
      Description: "Shot on the north shore during the winter swell. ".repeat(13),
    }));

    const render = summarizeListing({ items, totalItems: 20 });
    expect(render.text.length).toBeGreaterThan(8_000 * 0.85);
    expect(render.text.length).toBeLessThanOrEqual(8_000);
    expect(render.complete).toBe(true);
  });

  // R14: the stub carries a fixed ~110-character marker that a lean item does not, so stubbing a
  // lean item makes it LONGER. The fill must take the cheaper form per item, never assume the stub.
  it("leaves lean items in full and abbreviates only what actually does not fit", () => {
    const lean = Array.from({ length: 3 }, (_, index) => ({
      Name: `lean-${index}.txt`,
      Key: `Docs/lean-${index}.txt`,
      Size: 40,
    }));
    const heavy = { Name: "huge.bin", Key: "Archive/huge.bin", StorageId: "os-9", Description: "x".repeat(20_000) };

    const render = summarizeListing({ items: [heavy, ...lean], totalItems: 4 });
    const view = JSON.parse(render.text) as { shown: number; abbreviated: number; items: Record<string, unknown>[] };

    expect(view.shown).toBe(4);
    expect(view.abbreviated).toBe(1);
    expect(view.items[0]!.Abbreviated).toBe(ABBREVIATED_ITEM_NOTICE);
    expect(view.items[1]).toEqual(lean[0]);
    expect(render.complete).toBe(true);
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
