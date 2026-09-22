import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import { FIRST_PAGE_ITEMS, SMALLER_PAGE_RETRY_NOTICE } from "../../src/tools/format";
import { decodeCursor, encodeCursor, type PaginationDialect } from "../../src/client/pagination";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-667 round 4. `listing-walk.test.ts` proves the invariant across a walk; these are the
// properties of the ADAPTIVE SIZE itself that it does not pin down:
//   - the outbound page size is the value the skew check compares against, for a server that
//     over-answers by a little rather than by everything (the shared harness only models a
//     server that ignores the page size completely);
//   - the loop settles on uniform data instead of flipping between two sizes;
//   - it survives a drive whose item weight changes sharply mid-walk, in both directions;
//   - an envelope spending its entire budget share can cost the page its detail, never its items.
// Deliberately self-contained: the shared harness is the thing under suspicion, so nothing here
// depends on it.

const BUCKET = "cloudsee-demo";
const MAX_PAGE_ITEMS = 200;
const OUTPUT_BUDGET_CHARS = 8_000;
const CURSOR_PATTERN = /cursor="([^"]+)"/;
const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));

// ------------------------------------------------------------------- fixtures

/** ~100 rendered characters: a drive of loose files with no metadata and no folder tree.
 *  Fixed-width name and a constant Size, so every item costs the same — a fixture whose items
 *  drift in cost by a character would make the convergence assertion below meaningless. */
function leanItem(index: number): Record<string, unknown> {
  const name = `a-${String(index).padStart(4, "0")}.txt`;
  return { Name: name, Key: name, Size: 4096 };
}

/** ~569 rendered characters: the heaviest item an ordinary listing produces. */
function descriptiveItem(index: number): Record<string, unknown> {
  const name = `Quarterly Business Review ${String(index).padStart(3, "0")} - FY2026 Q3 EMEA regional approved summary (final).xlsx`;
  const key = `Extract/FY2026 Q3 exports/sub-folder-${String(index % 70).padStart(2, "0")}/${name}`;
  return {
    Name: name,
    Key: key,
    Size: 259578 + index,
    LastModified: "2026-08-14T03:21:55.000Z",
    IsFolder: false,
    StorageId: `937896d1f42416222e53d07baa80eab19af321d8ff6eb1a056da08b0f7ab${String(index).padStart(4, "0")}`,
    StorageClass: "STANDARD",
    Status: "Ready",
    Project: "Marketing",
    Category: "Quarterly reports",
  };
}

/** A `/storage/recent` row as `RecentDto` puts it on the wire: its recency timestamp is called
 *  `UpdatedAt`, and the row carries no `LastModified` of its own (CSD-672). */
function recentItem(index: number): Record<string, unknown> {
  const name = `Screenshot 2026-09-15 at 2.38.${String(index).padStart(2, "0")} PM.png`;
  return {
    Email: "daniela@webapper.net",
    Bucket: "csd-app-verify",
    StorageId: 1789767981603 + index,
    Name: name,
    Parent: "App-Verify-2026-09-15/",
    UpdatedAt: "2026-09-18T04:12:07.881Z",
    Key: `App-Verify-2026-09-15/${name}`,
  };
}

/** Heavy enough that the seed page cannot render whole — a user-entered Description. */
function heavyItem(index: number): Record<string, unknown> {
  return {
    ...descriptiveItem(index),
    Description: "Shot on the north shore during the winter swell. ".repeat(60),
  };
}

// ------------------------------------------------------------- the fake server

interface ServedPage {
  requested: number | undefined;
  items: Record<string, unknown>[];
  offeredCursor: boolean;
}

interface FakeServer {
  postPaged: ReturnType<typeof vi.fn>;
  served: ServedPage[];
}

interface FakeServerOptions {
  items: Record<string, unknown>[];
  bareArray: boolean;
  /** Envelope scalars the endpoint echoes back beside the totals. */
  envelopeScalars?: Record<string, unknown>;
  /** A server that over-answers: it returns the requested size plus this many extra objects. */
  extraObjectsPerPage?: number;
}

/**
 * Slices by the page size the tool actually sent, mints its cursor from the last item of the
 * slice it returned, honours that cursor on the next call, and offers no cursor once the fixture
 * is exhausted. Written from scratch rather than shared, so a change to the other harness cannot
 * silently weaken these assertions too.
 */
function fakeServer(options: FakeServerOptions): FakeServer {
  const { items, bareArray } = options;
  const served: ServedPage[] = [];

  const postPaged = vi.fn(
    async (_path: string, body: Record<string, unknown>, dialect: PaginationDialect, cursor?: string) => {
      const requested =
        typeof body.pageSize === "number" ? body.pageSize : typeof body.limit === "number" ? body.limit : undefined;
      const from = cursor === undefined ? 0 : positionAfter(items, String(decodeCursor(cursor, dialect)));
      const size = (requested ?? items.length) + (options.extraObjectsPerPage ?? 0);
      const page = items.slice(from, from + size);
      const last = page[page.length - 1];
      const nextCursor = from + page.length < items.length && last ? encodeCursor(dialect, String(last.Key)) : undefined;
      served.push({ requested, items: page, offeredCursor: nextCursor !== undefined });
      return {
        data: bareArray
          ? page
          : { items: page, totalItems: items.length, totalPages: 40, ...(options.envelopeScalars ?? {}) },
        nextCursor,
      };
    },
  );

  return { postPaged, served };
}

function positionAfter(items: Record<string, unknown>[], key: string): number {
  const at = items.findIndex((item) => String(item.Key) === key);
  if (at < 0) throw new Error(`the tool sent a cursor this server never minted: ${key}`);
  return at + 1;
}

function clientFor(server: FakeServer): CloudSeeClient {
  return { post: vi.fn(), postPaged: server.postPaged } as unknown as CloudSeeClient;
}

// --------------------------------------------------------------- walk helpers

function renderedView(text: string): Record<string, unknown> {
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close < open) throw new Error(`tool output carries no JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(open, close + 1)) as Record<string, unknown>;
}

function itemEntries(text: string): Record<string, unknown>[] {
  const items = renderedView(text).items;
  if (!Array.isArray(items)) throw new Error("tool output carries no items array");
  return items.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
}

interface WalkedPage {
  text: string;
  keys: string[];
  cursor: string | undefined;
}

async function walk(toolName: string, server: FakeServer, maxCalls = 400): Promise<WalkedPage[]> {
  const tool = byName[toolName]!;
  const client = clientFor(server);
  const base: Record<string, unknown> = toolName === "recent_files" ? {} : { bucketName: BUCKET };
  if (toolName === "search_files") base.query = "review";
  const pages: WalkedPage[] = [];
  let cursor: string | undefined;

  for (let call = 0; call < maxCalls; call += 1) {
    const result = await tool.handler({ ...base, ...(cursor ? { cursor } : {}) }, { client });
    const text = result.content[0]?.text ?? "";
    const next = CURSOR_PATTERN.exec(text)?.[1];
    pages.push({ text, keys: itemEntries(text).map((entry) => String(entry.Key)), cursor: next });
    if (next === undefined) return pages;
    cursor = next;
  }
  throw new Error(`${toolName}: the walk did not terminate within ${maxCalls} calls`);
}

interface RetryWalk {
  renderedKeys: Set<string>;
  retries: number;
  calls: number;
}

/**
 * The walk as the tool's own L3 instruction describes it: follow the cursor while one is offered,
 * and when a page comes back without one but with the retry notice, re-ask at the SAME cursor with
 * a smaller page size. A plain cursor-only driver cannot express that, and a drive whose item
 * weight changes mid-walk is exactly where the difference shows.
 */
async function walkFollowingRetries(toolName: string, server: FakeServer, maxCalls = 600): Promise<RetryWalk> {
  const tool = byName[toolName]!;
  const client = clientFor(server);
  const base: Record<string, unknown> = { bucketName: BUCKET };
  const renderedKeys = new Set<string>();
  let cursor: string | undefined;
  let pageSize: number | undefined;
  let retries = 0;

  for (let call = 0; call < maxCalls; call += 1) {
    const args = { ...base, ...(cursor ? { cursor } : {}), ...(pageSize === undefined ? {} : { pageSize }) };
    const text = (await tool.handler(args, { client })).content[0]?.text ?? "";
    const next = CURSOR_PATTERN.exec(text)?.[1];

    if (next === undefined && text.includes(SMALLER_PAGE_RETRY_NOTICE)) {
      const sent = server.served[server.served.length - 1]!.requested!;
      expect(sent, "the retry chain must terminate before the page size reaches zero").toBeGreaterThan(1);
      pageSize = Math.max(1, Math.floor(sent / 2));
      retries += 1;
      continue;
    }

    itemEntries(text).forEach((entry) => renderedKeys.add(String(entry.Key)));
    if (next === undefined) return { renderedKeys, retries, calls: server.served.length };
    cursor = next;
    pageSize = undefined;
  }
  throw new Error(`${toolName}: the walk did not terminate within ${maxCalls} calls`);
}

/** The three clauses of CSD-667 §2, asserted against what this server actually returned. */
function assertWalkIsSound(toolName: string, server: FakeServer, pages: WalkedPage[], fixtureSize: number): void {
  pages.forEach((page, index) => {
    const servedPage = server.served[index]!;
    if (servedPage.items.length > 0) {
      expect(page.keys.length, `${toolName}: page ${index + 1} rendered no item entries`).toBeGreaterThanOrEqual(1);
    }
    if (page.cursor !== undefined) {
      expect(
        page.keys.length,
        `${toolName}: page ${index + 1} emitted a cursor after rendering ${page.keys.length} of ${servedPage.items.length} served items`,
      ).toBe(servedPage.items.length);
    }
  });

  const rendered = new Set(pages.flatMap((page) => page.keys));
  const servedKeys = new Set(server.served.flatMap((page) => page.items.map((item) => String(item.Key))));
  expect(rendered, `${toolName}: the walk did not render every item the server returned`).toEqual(servedKeys);
  expect(servedKeys.size, `${toolName}: the server itself did not serve the whole fixture`).toBe(fixtureSize);
}

function outboundSizes(server: FakeServer): number[] {
  return server.served.map((page) => page.requested!);
}

// ---------------------------------------------------------------- the gap: R2

// CSD-667 R2. `list_files` sends a page size and compares the answer against it to detect a drive
// that does not honour it. The shared harness only models a server that ignores the page size
// ENTIRELY (700 objects for a request of 13), and that case still trips a check written against
// any bound at all — so replacing the outbound value with the caller's ask, or with the schema
// maximum, leaves the whole suite green. A server that over-answers by a LITTLE is the case that
// separates them, and it is the likelier deploy-order shape: a storage-api build that caps at its
// own default rather than at the requested size.
describe("list_files compares the drive's answer against the size it actually sent (CSD-667 R2)", () => {
  it("reports the shortfall and withholds the cursor when the drive over-answers by a few objects", async () => {
    const items = Array.from({ length: 120 }, (_, index) => leanItem(index));
    const server = fakeServer({ items, bareArray: true, extraObjectsPerPage: 5 });

    const result = await byName["list_files"]!.handler({ bucketName: BUCKET }, { client: clientFor(server) });
    const text = result.content[0]?.text ?? "";

    expect(server.served[0]!.requested, "the first call sends the seed").toBe(FIRST_PAGE_ITEMS);
    expect(server.served[0]!.items.length, "the fixture must make the drive over-answer").toBe(FIRST_PAGE_ITEMS + 5);
    expect(server.served[0]!.offeredCursor, "the drive must offer a cursor for withholding it to mean anything").toBe(
      true,
    );

    expect(text).toContain(`returned ${FIRST_PAGE_ITEMS + 5} objects for a requested page size of ${FIRST_PAGE_ITEMS}`);
    expect(itemEntries(text).length, "the rendered slice is bounded by what was requested").toBeLessThanOrEqual(
      FIRST_PAGE_ITEMS,
    );
    expect(
      CURSOR_PATTERN.test(text),
      "following the drive's own cursor would skip the objects past the rendered slice",
    ).toBe(false);
  });

  it("does not cry skew when the drive honours the adaptive size exactly", async () => {
    const items = Array.from({ length: 120 }, (_, index) => leanItem(index));
    const server = fakeServer({ items, bareArray: true });

    const pages = await walk("list_files", server);

    pages.forEach((page, index) => {
      expect(page.text, `page ${index + 1} reported a shortfall that did not happen`).not.toContain(
        "did not honour the page size",
      );
    });
    expect(new Set(outboundSizes(server)).size, "this fixture must actually move the page size").toBeGreaterThan(1);
    assertWalkIsSound("list_files", server, pages, items.length);
  });
});

// ------------------------------------------------- convergence and divergence

describe("the adaptive page size converges instead of oscillating (CSD-667)", () => {
  for (const [label, makeItem] of [
    ["lean", leanItem],
    ["descriptive", descriptiveItem],
  ] as const) {
    it(`settles on one size for a drive of uniform ${label} items`, async () => {
      const items = Array.from({ length: 600 }, (_, index) => makeItem(index));
      const server = fakeServer({ items, bareArray: false });

      const pages = await walk("browse_folder", server);
      const sizes = outboundSizes(server);

      expect(sizes[0], "the first call has measured nothing").toBe(FIRST_PAGE_ITEMS);
      // Every later call measures the same uniform items, so it must ask for the same size.
      // A loop that flipped between two values would show more than one here.
      const afterTheSeed = new Set(sizes.slice(1));
      expect(
        afterTheSeed.size,
        `${label}: the page size never settled — it asked for ${[...afterTheSeed].join(", ")}`,
      ).toBe(1);
      expect(sizes.length, "the fixture must be long enough to show a trend").toBeGreaterThan(4);
      assertWalkIsSound("browse_folder", server, pages, items.length);
    });
  }

  // CSD-672. Publishing the recent row's `UpdatedAt` as `LastModified` adds ~40 characters to every
  // `recent_files` item, so the adaptive loop buys a smaller page — measured 38 → 30 on this
  // fixture. That is the intended behaviour of the loop, not a regression, and it must stay a
  // SETTLED size between the seed and the ceiling: no clamp, no stubbing, no withheld cursor.
  // The sizes are compared rather than written out, because the budget calibration has moved before.
  it("buys a smaller recent_files page for the timestamp it now publishes", async () => {
    const timestamped = fakeServer({ items: Array.from({ length: 200 }, (_, i) => recentItem(i)), bareArray: true });
    const untimestamped = fakeServer({
      items: Array.from({ length: 200 }, (_, i) => {
        const { UpdatedAt: _recencyTimestamp, ...rest } = recentItem(i);
        return rest;
      }),
      bareArray: true,
    });

    const pages = await walk("recent_files", timestamped);
    await walk("recent_files", untimestamped);

    const sizes = outboundSizes(timestamped);
    expect(sizes[0], "the first call has measured nothing").toBe(FIRST_PAGE_ITEMS);
    expect(new Set(sizes.slice(1)).size, `the size never settled — it asked for ${sizes.slice(1).join(", ")}`).toBe(1);
    expect(sizes[1]!, "the published timestamp must cost the page some items").toBeLessThan(
      outboundSizes(untimestamped)[1]!,
    );
    expect(sizes[1]!, "still above the seed, so no clamp and no stubbing").toBeGreaterThan(FIRST_PAGE_ITEMS);
    expect(sizes[1]!, "still below the schema maximum").toBeLessThan(MAX_PAGE_ITEMS);
    assertWalkIsSound("recent_files", timestamped, pages, 200);
  });

  it("grows for lean items and shrinks for heavy ones, from the same seed", async () => {
    const lean = fakeServer({ items: Array.from({ length: 600 }, (_, i) => leanItem(i)), bareArray: false });
    const heavy = fakeServer({ items: Array.from({ length: 60 }, (_, i) => heavyItem(i)), bareArray: false });

    await walk("browse_folder", lean);
    await walk("browse_folder", heavy);

    expect(outboundSizes(lean)[1], "lean items leave budget the walk should be spending").toBeGreaterThan(
      FIRST_PAGE_ITEMS,
    );
    expect(outboundSizes(heavy)[1], "heavy items must buy a smaller next page").toBeLessThan(FIRST_PAGE_ITEMS);
  });
});

describe("the adaptive page size cannot diverge to a pathological value (CSD-667)", () => {
  // The hint is measured on the PREVIOUS page, so a drive whose weight changes mid-walk hands the
  // next call a size calibrated for items it will not receive. Light-then-heavy is the dangerous
  // direction: the page size is at its largest exactly when the items get heavy, so that page
  // lands in L2 or L3 and clause 2 has to hold there.
  for (const [label, weightAt] of [
    ["light pages first, then heavy ones", (index: number) => (index < 300 ? leanItem(index) : heavyItem(index))],
    ["heavy pages first, then light ones", (index: number) => (index < 40 ? heavyItem(index) : leanItem(index))],
  ] as const) {
    it(`reaches every item with ${label}`, async () => {
      const items = Array.from({ length: 500 }, (_, index) => weightAt(index));
      const server = fakeServer({ items, bareArray: false });

      const walked = await walkFollowingRetries("browse_folder", server);
      const sizes = outboundSizes(server);

      expect(Math.min(...sizes), "the page size must never fall below one item").toBeGreaterThanOrEqual(1);
      expect(Math.max(...sizes), "the page size must never pass the schema maximum").toBeLessThanOrEqual(
        MAX_PAGE_ITEMS,
      );
      // Never pinned at one item for the whole walk: that would be a size that cannot recover.
      expect(sizes.filter((size) => size === 1).length, "the walk got stuck at one item per page").toBeLessThan(
        sizes.length,
      );
      expect(walked.renderedKeys, "the walk lost items when the item weight changed under it").toEqual(
        new Set(items.map((item) => String(item.Key))),
      );
    });
  }

  // A page size measured on light items and spent on heavy ones is the one case where the previous
  // page's evidence is actively wrong. The walk must still be finishable, and it is — but only by
  // following the L3 instruction: a cursor-only walk stops there with items unread, which is the
  // designed behaviour (clause 2 withholds the cursor rather than skipping what it could not show).
  it("withholds the cursor rather than skipping items when a grown page meets heavy ones", async () => {
    const items = [
      ...Array.from({ length: 300 }, (_, index) => leanItem(index)),
      ...Array.from({ length: 200 }, (_, index) => heavyItem(index + 300)),
    ];
    const server = fakeServer({ items, bareArray: false });

    const pages = await walk("browse_folder", server);
    const stalled = pages[pages.length - 1]!;
    const servedOnTheStalledPage = server.served[server.served.length - 1]!;

    expect(outboundSizes(server)[1], "the lean pages must grow the size first").toBeGreaterThan(FIRST_PAGE_ITEMS);
    expect(stalled.cursor, "the page that could not be rendered whole must withhold its cursor").toBeUndefined();
    expect(servedOnTheStalledPage.offeredCursor, "the server did offer one — withholding it is a decision").toBe(true);
    expect(stalled.keys.length, "clause 3 — a partial page still renders at least one item").toBeGreaterThanOrEqual(1);
    expect(stalled.keys.length, "this fixture only proves something if the page is genuinely partial").toBeLessThan(
      servedOnTheStalledPage.items.length,
    );
    expect(stalled.text, "clause 3 — it must name the action that moves the walk on").toContain(
      SMALLER_PAGE_RETRY_NOTICE,
    );
    // Nothing the connector DID render was skipped; the walk simply stops short of the fixture.
    pages.forEach((page, index) => {
      if (page.cursor !== undefined) expect(page.keys.length).toBe(server.served[index]!.items.length);
    });
  });
});

// ------------------------------------------------ the envelope's budget share

// CSD-667. `ENVELOPE_BUDGET_SHARE` caps the envelope at one eighth of the budget. At the heaviest
// realistic item weight a seed page of items costs ~7 400 characters, so an envelope spending its
// full share pushes the render past the budget. That must cost the page its DETAIL (L2), never its
// completeness — otherwise a verbose endpoint could withhold the cursor on every page of a walk.
describe("an envelope spending its whole budget share never costs the page its cursor", () => {
  it("abbreviates rather than truncating, and still advertises the next page", async () => {
    const envelopeScalars = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`describedField${index}`, `${"d".repeat(400)}-${index}`]),
    );
    const items = Array.from({ length: 200 }, (_, index) => descriptiveItem(index));
    const server = fakeServer({ items, bareArray: false, envelopeScalars });

    const result = await byName["browse_folder"]!.handler({ bucketName: BUCKET }, { client: clientFor(server) });
    const text = result.content[0]?.text ?? "";
    const view = renderedView(text);

    expect(() => renderedView(text), "the render must be parseable JSON, not a mid-string cut").not.toThrow();
    expect(view.totalItems, "the truncation signals are exempt from the envelope budget").toBe(items.length);
    expect(view.droppedFields, "an envelope that did not fit must say so").toBeGreaterThanOrEqual(1);
    expect(itemEntries(text).length, "every item of the page keeps its identity").toBe(FIRST_PAGE_ITEMS);
    expect(CURSOR_PATTERN.test(text), "a complete page must hand back the cursor to the next one").toBe(true);
    expect(text.length, "the render may overrun only by the first item, never by the envelope").toBeLessThan(
      OUTPUT_BUDGET_CHARS * 1.5,
    );
  });

  it("reaches every item across a walk whose envelope is that verbose", async () => {
    const envelopeScalars = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`describedField${index}`, `${"d".repeat(400)}-${index}`]),
    );
    const items = Array.from({ length: 120 }, (_, index) => descriptiveItem(index));
    const server = fakeServer({ items, bareArray: false, envelopeScalars });

    const pages = await walk("browse_folder", server);

    assertWalkIsSound("browse_folder", server, pages, items.length);
  });
});
