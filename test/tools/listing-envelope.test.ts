import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import {
  FIRST_PAGE_ITEMS,
  SMALLER_PAGE_RETRY_NOTICE,
  TRUNCATED_KEY_NOTICE,
  TRUNCATED_SCALAR_NOTICE,
} from "../../src/tools/format";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-667. `renderLongestPrefix` no longer falls back to a raw `json.slice(0, maxChars)`; the claim
// that replaced it is that a bounded envelope makes a text cut STRUCTURALLY unreachable on the
// listing path. `format.test.ts` proves the bound for the one scalar shape production is known to
// send (/storage/list's encrypted `query` echo). This file attacks the claim from the other side —
// envelope shapes nobody designed for, driven through the real tools — and holds every one of them
// to the same three obligations: the render PARSES, it carries at least one item entry, and it
// either reaches the rest (a cursor) or names the action that does (the L3 retry instruction).

const BUCKET = "cloudsee-demo";
const CURSOR_PATTERN = /cursor="([^"]+)"/;
const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));

function indexDocument(index: number): Record<string, unknown> {
  const name = `surf-${String(index).padStart(3, "0")}.jpg`;
  return {
    Name: name,
    Key: `Photos/${name}`,
    Size: 259578 + index,
    LastModified: "2026-08-14T03:21:55.000Z",
    IsFolder: false,
    StorageId: `937896d1f42416222e53d07baa80eab19af321d8ff6eb1a056da08b0f7ab${String(index).padStart(4, "0")}`,
    StorageClass: "STANDARD",
    Status: "Ready",
  };
}

function clientReturning(data: unknown, nextCursor: string | undefined): CloudSeeClient {
  return { post: vi.fn(), postPaged: vi.fn(async () => ({ data, nextCursor })) } as unknown as CloudSeeClient;
}

/** The rendered JSON body, with any trailing cursor hint or notice stripped. */
function renderedView(text: string): Record<string, unknown> {
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close < open) throw new Error(`tool output carries no JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(open, close + 1)) as Record<string, unknown>;
}

function itemEntries(text: string): unknown[] {
  const items = renderedView(text).items;
  if (!Array.isArray(items)) throw new Error("tool output carries no items array");
  return items.filter((entry) => entry !== undefined && entry !== null);
}

/** `search_files` over an envelope of the caller's choosing, holding 20 ordinary index documents. */
async function searchOverEnvelope(envelopeScalars: Record<string, unknown>): Promise<string> {
  const items = Array.from({ length: 20 }, (_, index) => indexDocument(index));
  const client = clientReturning(
    { items, totalItems: 200, totalPages: 10, ...envelopeScalars },
    "server-offered-cursor",
  );
  const result = await byName["search_files"]!.handler({ bucketName: BUCKET, query: "surf" }, { client });
  return result.content[0]?.text ?? "";
}

/** The three obligations an adversarial envelope may never cost a page that carries items. */
function expectUsablePage(label: string, text: string): void {
  expect(() => renderedView(text), `${label}: the render must parse, not end mid-string`).not.toThrow();
  expect(itemEntries(text).length, `${label}: the page rendered no item entries`).toBeGreaterThanOrEqual(1);
  expect(
    CURSOR_PATTERN.test(text) || text.includes(SMALLER_PAGE_RETRY_NOTICE),
    `${label}: the page neither reaches the rest nor names the action that does`,
  ).toBe(true);
  expect(text, `${label}: the listing path reached the character cut it is supposed to have made unreachable`).not.toContain(
    "output truncated at",
  );
}

describe("an adversarial envelope never costs a page its items (CSD-667)", () => {
  // CSD-667, replacement. This case used to require that the 80th scalar was rendered too — which
  // took a bounded value each and an unbounded envelope in total: 80 of them rendered 20 759
  // characters against a budget of 8 000. Its intent is kept — the envelope survives, visibly cut
  // rather than silently — and the bound is now on the envelope as a whole: the scalars that fit
  // are published, the rest are counted in `droppedFields`, and the items keep their share.
  it("survives many oversized scalars, not just one", async () => {
    const scalars = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`echoedField${index}`, "y".repeat(500)]),
    );
    const text = await searchOverEnvelope(scalars);

    expectUsablePage("80 oversized scalars", text);
    const view = renderedView(text);
    expect(String(view.echoedField0)).toContain(TRUNCATED_SCALAR_NOTICE);
    expect(view.droppedFields, "what the envelope could not carry must be counted, not dropped silently").toBeGreaterThan(
      0,
    );
    expect(view.totalItems).toBe(200); // the numbers that describe the result set are never dropped
    expect(itemEntries(text)).toHaveLength(20);
  });

  it("survives an oversized KEY name, which the value bound does not reach", async () => {
    const text = await searchOverEnvelope({ [`echo${"Field".repeat(2_000)}`]: 1 });
    expectUsablePage("one 10 000-character key name", text);
  });

  it("leaves non-string scalars whole and unmarked — only a long string is ever cut", async () => {
    const text = await searchOverEnvelope({ scannedBytes: Number.MAX_SAFE_INTEGER, isTruncated: false, nextPage: null });
    const view = renderedView(text);

    expect(view.scannedBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(view.isTruncated).toBe(false);
    expect(view.nextPage).toBeNull();
    expect(text).not.toContain(TRUNCATED_SCALAR_NOTICE);
    expectUsablePage("non-string scalars", text);
  });

  it("bounds an unexpected extra scalar the same way as a known one", async () => {
    const text = await searchOverEnvelope({ unexpectedDiagnosticField: "d".repeat(9_000) });
    const view = renderedView(text);

    expect(String(view.unexpectedDiagnosticField)).toContain(TRUNCATED_SCALAR_NOTICE);
    expect(String(view.unexpectedDiagnosticField).length).toBeLessThan(300);
    expect(view.totalItems).toBe(200); // the numbers that describe the result set are never cut
    expectUsablePage("an unexpected extra scalar", text);
  });

  it("drops a nested object that is not items, rather than spending the budget on it", async () => {
    const aggregations = {
      buckets: Array.from({ length: 5_000 }, (_, index) => ({ key: `folder-${index}`, doc_count: index })),
    };
    const text = await searchOverEnvelope({ aggregations });

    expect(renderedView(text).aggregations).toBeUndefined();
    expect(itemEntries(text)).toHaveLength(20); // the whole page still fits, so a cursor is due
    expect(CURSOR_PATTERN.test(text)).toBe(true);
    expectUsablePage("a nested non-items object", text);
  });

  it("still publishes an item that is a bare string rather than an object", async () => {
    const client = clientReturning({ items: ["z".repeat(30_000)], totalItems: 1 }, "server-offered-cursor");
    const text = (await byName["search_files"]!.handler({ bucketName: BUCKET, query: "q" }, { client })).content[0]?.text ?? "";

    expectUsablePage("an item that is a bare string", text);
    expect(CURSOR_PATTERN.test(text), "an item rendered in full is not grounds to withhold the cursor").toBe(true);
  });
});

// CSD-667. `boundScalar` bounds a scalar's VALUE. It bounds neither the KEY it is written under
// nor the NUMBER of scalars, so the envelope could still grow without limit: measured through the
// real tools, one 40 000-character key name rendered 40 538 characters against an 8 000-character
// budget, and 200 bounded scalars rendered 51 219. Past ~31 scalars the ladder had nothing left to
// give back and broke the budget outright. The envelope exists to DESCRIBE the result set; it may
// never consume the budget the result set itself needs.
describe("the envelope can never spend the budget the items need (CSD-667)", () => {
  const RENDER_BUDGET_CHARS = 8_000;

  /** The rendered listing body — what the budget is spent on, before withCursor's hint. */
  function renderedBody(text: string): string {
    const open = text.indexOf("{");
    const close = text.lastIndexOf("}");
    if (open < 0 || close < open) throw new Error(`tool output carries no JSON object: ${text.slice(0, 200)}`);
    return text.slice(open, close + 1);
  }

  /** The obligations of `expectUsablePage`, plus the budget and the fields that make truncation
   *  detectable. Twenty projected index documents cost ~5 900 characters, so every case below
   *  fits the budget whole — no first-item overrun is in play. */
  function expectBoundedPage(label: string, text: string): void {
    expectUsablePage(label, text);
    expect(renderedBody(text).length, `${label}: the envelope pushed the render past the budget`).toBeLessThanOrEqual(
      RENDER_BUDGET_CHARS,
    );
    const view = renderedView(text);
    expect(view.totalItems, `${label}: totalItems did not survive`).toBe(200);
    expect(view.totalPages, `${label}: totalPages did not survive`).toBe(10);
    expect(typeof view.shown, `${label}: shown did not survive`).toBe("number");
  }

  /** Every scalar the envelope carried is either published or counted in `droppedFields`. */
  function expectEveryScalarAccountedFor(label: string, text: string, sent: number): void {
    const view = renderedView(text);
    const published = Object.keys(view).filter((key) => key.startsWith("echoedField")).length;
    const dropped = typeof view.droppedFields === "number" ? view.droppedFields : 0;
    expect(published + dropped, `${label}: ${sent - published - dropped} scalar(s) vanished unreported`).toBe(sent);
  }

  it("bounds a single oversized KEY name, which the value bound does not reach", async () => {
    const text = await searchOverEnvelope({ [`echo${"Field".repeat(8_000)}`]: 1 });

    expectBoundedPage("one 40 000-character key name", text);
    const cutKey = Object.keys(renderedView(text)).find((key) => key.startsWith("echoField"));
    expect(cutKey, "the key was cut, so the cut must be visible in the key itself").toContain(TRUNCATED_KEY_NOTICE);
  });

  it("bounds many long key names", async () => {
    const scalars = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`echoedField${index}${"Name".repeat(225)}`, index]),
    );
    const text = await searchOverEnvelope(scalars);

    expectBoundedPage("60 key names of ~900 characters", text);
    expectEveryScalarAccountedFor("60 key names of ~900 characters", text, 60);
  });

  it("bounds the envelope however many scalars it carries", async () => {
    for (const count of [4, 20, 32, 40, 80, 200]) {
      const scalars = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`echoedField${index}`, `${index}`.repeat(50)]),
      );
      const text = await searchOverEnvelope(scalars);

      expectBoundedPage(`${count} scalars`, text);
      expectEveryScalarAccountedFor(`${count} scalars`, text, count);
    }
  });

  it("bounds an envelope that combines long keys, long values and many of both", async () => {
    const scalars = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `echoedField${index}${"Name".repeat(200)}`,
        "y".repeat(1_500),
      ]),
    );
    const text = await searchOverEnvelope(scalars);

    expectBoundedPage("120 long keys with long values", text);
    expectEveryScalarAccountedFor("120 long keys with long values", text, 120);
  });
});

// CSD-667. An empty page is a COMPLETE render — there is no item left behind — so the cursor must
// travel with it. `/storage/list`'s permission filter and the server's scan cap both hand back an
// empty page while the marker still points past it, so withholding the cursor there ends the walk
// on a page that proves nothing about the end of the list.
describe("an empty page is complete and forwards the cursor (CSD-667)", () => {
  it("search_files forwards the cursor over an empty page, whatever the envelope costs", async () => {
    const client = clientReturning(
      { items: [], totalItems: 200, totalPages: 10, [`echo${"Field".repeat(8_000)}`]: 1 },
      "server-offered-cursor",
    );
    const text = (await byName["search_files"]!.handler({ bucketName: BUCKET, query: "surf" }, { client })).content[0]?.text ?? "";

    const view = renderedView(text);
    expect(view.shown).toBe(0);
    expect(view.items).toEqual([]);
    expect(CURSOR_PATTERN.exec(text)?.[1], "an empty page left nothing behind, so the walk must go on").toBe(
      "server-offered-cursor",
    );
  });
});

// CSD-667 / CSD-662 F2. `TRUNCATION_SIGNAL_FIELDS` renders `totalItems` and `totalPages` FIRST and
// exempts them from the envelope budget. Every case above happens to send those two ahead of the
// noise, so the budget reaches them before it runs out and the exemption is never what saves them:
// deleting the whole mechanism leaves all of them green. A server is under no obligation to order
// its JSON that way, and the moment it does not, a budget-exhausting envelope drops exactly the two
// numbers that reveal a partial page — which is CSD-662 F2 again, one layer up.
describe("the fields that reveal a truncation are exempt from the envelope budget (CSD-662 F2)", () => {
  /** The same page, with the noise scalars ahead of the totals in payload order. */
  async function searchOverEnvelopeNoiseFirst(noise: Record<string, unknown>): Promise<string> {
    const items = Array.from({ length: 20 }, (_, index) => indexDocument(index));
    const client = clientReturning({ ...noise, items, totalItems: 200, totalPages: 10 }, "server-offered-cursor");
    const result = await byName["search_files"]!.handler({ bucketName: BUCKET, query: "surf" }, { client });
    return result.content[0]?.text ?? "";
  }

  // The noise is many SHORT scalars on purpose. A few long ones do not exhaust the budget: the
  // loop that spends it skips what does not fit and keeps going, so a 21-character `totalItems`
  // still slides in behind them. Only an envelope whose scalars are individually cheap can fill
  // the share completely, and that is the shape that puts the two signal fields at real risk.
  it("keeps totalItems and totalPages when the budget is exhausted before the payload reaches them", async () => {
    const noise = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`echoedField${index}`, index]),
    );
    const text = await searchOverEnvelopeNoiseFirst(noise);
    const view = renderedView(text);

    expect(view.totalItems, "the count that reveals a partial page was dropped by the envelope budget").toBe(200);
    expect(view.totalPages, "the page count that reveals a partial page was dropped by the envelope budget").toBe(10);
    expect(view.droppedFields, "the noise, not the signals, is what must be dropped").toBeGreaterThan(0);
    expectUsablePage("300 scalars ahead of the totals", text);
  });

  it("renders the truncation signals before any descriptive scalar, so a downstream cut reaches them last", async () => {
    const text = await searchOverEnvelopeNoiseFirst({ folderSize: 98765432109, query: null });
    const keys = Object.keys(renderedView(text));

    const signals = ["totalItems", "totalPages", "shown", "totalReturned", "abbreviated"].filter((field) =>
      keys.includes(field),
    );
    expect(keys.slice(0, signals.length), "a signal field was pushed behind a descriptive one").toEqual(signals);
    expect(keys.indexOf("totalItems")).toBeLessThan(keys.indexOf("folderSize"));
    expect(keys.indexOf("totalPages")).toBeLessThan(keys.indexOf("folderSize"));
    expect(keys[keys.length - 1], "items are rendered last, after everything that describes them").toBe("items");
  });
});

// CSD-667. `droppedFields` is a NEW field in tool output. It is a defect report, so it may only
// appear when there is a defect to report: a model that sees it on an ordinary page is being told
// the listing is lossy when it is not. The envelope `/storage/list` really returns is
// `{items, totalItems, nextPage, totalPages, folderSize, query}` (SearchObjectService.js:82-89) and
// `/storage/bucket/files` + `/storage/recent` return a bare array, so no production listing has
// anything for the 1/8 budget to drop.
describe("droppedFields never appears on a page the envelope fits (CSD-667)", () => {
  // A FULL page, taken from the constant rather than written out as 20: `list_files` compares the
  // objects it received against the page size it actually sent, so a fixture that hard-codes the
  // old seed now reads as a drive that ignored the page size and takes the skew branch instead
  // of the ordinary one this case is about (CSD-667).
  const items = Array.from({ length: FIRST_PAGE_ITEMS }, (_, index) => indexDocument(index));
  /** SearchObjectService returns `nextPage` as the OpenSearch `sort` array of the last hit. */
  const nextPage = [1755141715000, "Photos/surf-019.jpg"];

  const productionShapes = [
    ["browse_folder", { bucketName: BUCKET }, { items, totalItems: 200, nextPage, totalPages: 10, folderSize: 98765432109, query: null }],
    ["search_files", { bucketName: BUCKET, query: "surf" }, { items, totalItems: 200, nextPage, totalPages: 10, folderSize: 98765432109, query: null }],
    ["list_files", { bucketName: BUCKET }, items],
    ["recent_files", {}, items],
  ] as const;

  for (const [toolName, args, data] of productionShapes) {
    it(`${toolName} reports no dropped field for the envelope the endpoint actually returns`, async () => {
      const client = clientReturning(data, "server-offered-cursor");
      const text = (await byName[toolName]!.handler(args, { client })).content[0]?.text ?? "";
      const view = renderedView(text);

      expect(view.droppedFields, "a clean page must not tell the model that fields were lost").toBeUndefined();
      expect(text).not.toContain(TRUNCATED_SCALAR_NOTICE);
      expect(text).not.toContain(TRUNCATED_KEY_NOTICE);
      expect(itemEntries(text)).toHaveLength(FIRST_PAGE_ITEMS);
    });
  }

  // The bound exists for a `query` that is not null. It only fires when the caller sends
  // `defaultQuery`, which neither MCP tool does — but the renderer must stay honest if it ever
  // arrives, and the cost of that honesty is a visibly cut ciphertext, not a lost page.
  it("cuts a non-null encrypted query visibly and still keeps the whole envelope inside its share", async () => {
    const encryptedQuery = `U2FsdGVkX1${"8ZmK3pQwR7tYuI2oP5aS9dF0gH1jK4lZxC6vB8nM".repeat(50)}`;
    const client = clientReturning(
      { items, totalItems: 200, nextPage, totalPages: 10, folderSize: 98765432109, query: encryptedQuery },
      "server-offered-cursor",
    );
    const text = (await byName["search_files"]!.handler({ bucketName: BUCKET, query: "surf" }, { client })).content[0]?.text ?? "";
    const view = renderedView(text);

    expect(String(view.query)).toContain(TRUNCATED_SCALAR_NOTICE);
    expect(view.droppedFields, "a cut query is not grounds to drop folderSize as well").toBeUndefined();
    expect(view.folderSize).toBe(98765432109);
    // 1/8 of the 8 000-character default. The real envelope spends a fraction of it, so the split
    // has headroom for fields these endpoints do not send yet.
    const envelopeOnly = JSON.stringify({ ...view, items: undefined }, null, 2).length;
    expect(envelopeOnly, "the production envelope no longer fits its share of the budget").toBeLessThanOrEqual(1_000);
  });
});

// The scalar bound may only fire on an envelope that actually carries an oversized value. Every
// listing tool other than search_files answers with descriptive scalars or no envelope at all, so
// fix 1 has to be invisible to them — a truncation marker on a folder path or a sort option would
// be a new defect, not a fix.
describe("the scalar bound is a no-op for the listing tools whose envelopes are descriptive", () => {
  // A full page from the constant, for the same reason as the block above: hard-coding the old
  // seed makes `list_files` read this fixture as a drive that ignored the page size (CSD-667).
  const items = Array.from({ length: FIRST_PAGE_ITEMS }, (_, index) => indexDocument(index));
  const cases = [
    ["browse_folder", { bucketName: BUCKET }, { items, totalItems: 200, totalPages: 10, dirPath: "Photos/", sortOption: "name_asc" }],
    ["list_files", { bucketName: BUCKET }, items],
    ["recent_files", {}, items],
  ] as const;

  for (const [toolName, args, data] of cases) {
    it(`${toolName} renders every item, marks nothing as truncated and forwards the cursor`, async () => {
      const client = clientReturning(data, "server-offered-cursor");
      const text = (await byName[toolName]!.handler(args, { client })).content[0]?.text ?? "";

      expect(itemEntries(text)).toHaveLength(FIRST_PAGE_ITEMS);
      expect(text).not.toContain(TRUNCATED_SCALAR_NOTICE);
      expect(text).not.toContain(SMALLER_PAGE_RETRY_NOTICE);
      expect(text).not.toContain("output truncated at");
      expect(CURSOR_PATTERN.exec(text)?.[1]).toBe("server-offered-cursor");
    });
  }
});
