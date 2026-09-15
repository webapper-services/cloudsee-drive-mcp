import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import {
  ABBREVIATED_ITEM_NOTICE,
  FIRST_PAGE_ITEMS,
  SMALLER_PAGE_RETRY_NOTICE,
  TRUNCATED_SCALAR_NOTICE,
} from "../../src/tools/format";
import { decodeCursor, encodeCursor, readPageSizeHint, type PaginationDialect } from "../../src/client/pagination";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-667. The suite this file joins tests `summarizeListing` and `withCursor` in isolation, and
// both pass on the defective build: the defect only exists ACROSS THE SEAM between two pages —
// the renderer shows k items, the cursor describes all n the server returned, and items k+1..n
// are rendered on no page and skipped by the next call. Every assertion here is one of the three
// invariant clauses of documents/csd-667/csd-667-analysis.md §2, walked to exhaustion:
//   1. completeness — the union of rendered identities equals the union the server returned;
//   2. cursor honesty — a cursor is emitted only when the whole server page was rendered;
//   3. always a way forward — no page renders zero items while the server returned some.

const BUCKET = "cloudsee-demo";
const CURSOR_PATTERN = /cursor="([^"]+)"/;
const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));

const ENVELOPE_TOOLS = ["browse_folder", "search_files"] as const;
const BARE_ARRAY_TOOLS = ["list_files", "recent_files"] as const;
const ALL_LISTING_TOOLS = [...ENVELOPE_TOOLS, ...BARE_ARRAY_TOOLS] as const;
type ListingTool = (typeof ALL_LISTING_TOOLS)[number];

// ---------------------------------------------------------------- fixtures

/** A realistic UNPROJECTED `/storage/list` index document — the `{...doc._source, _id}` shape
 *  SearchObjectService returns verbatim. ~2 300 characters against an 8 000-character budget. */
function indexDocument(index: number): Record<string, unknown> {
  const name = `surf-${String(index).padStart(3, "0")}.jpg`;
  const id = String(index).padStart(4, "0");
  return {
    Name: name,
    Key: `Photos/${name}`,
    Path: `Photos/${name}`,
    Size: 259578 + index,
    LastModified: "2026-08-14T03:21:55.000Z",
    IsFolder: false,
    StorageId: `937896d1f42416222e53d07baa80eab19af321d8ff6eb1a056da08b0f7ab${id}`,
    StorageClass: "STANDARD",
    Status: "Ready",
    Project: "",
    Category: "",
    Description: "",
    RestoreStatus: "",
    ETag: `"e4d909c290d0fb1ca068ffaddf22cbd0${id}"`,
    ChecksumAlgorithm: ["CRC32"],
    Account: "webapper-production",
    BucketName: BUCKET,
    ObjectKey: `Photos/${name}`,
    Prefix: "Photos/",
    Parent: "Photos/",
    ParentPaths: ["", "Photos/"],
    SanitizedName: name,
    SanitizedKey: `photos/${name}`,
    _id: `os-${id}-937896d1f42416222e53d07baa80eab1`,
    ObjectUUID: `3f1c9a7e-2b44-4d51-9c8a-${id}0d5e6f7a8b9`,
    InputSource: "s3-event",
    ReplicationStatus: "COMPLETED",
    KeyLength: `Photos/${name}`.length,
    FolderLevel: 1,
    IsS3Object: true,
    IsRealFolder: false,
    CreatedBy: "indexer@webapper.net",
    CreatedAt: "2026-08-14T03:21:56.000Z",
    UpdatedAt: "2026-08-14T03:21:56.000Z",
    Metadata: Object.fromEntries(
      Array.from({ length: 24 }, (_, field) => [`IndexField${field}`, "N/A placeholder written by the indexer"]),
    ),
  };
}

function indexDocuments(count: number, start = 0): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, offset) => indexDocument(start + offset));
}

/** An item whose kept fields alone are heavy — projection cannot rescue it. */
function heavyDocument(index: number): Record<string, unknown> {
  return {
    ...indexDocument(index),
    Description: "Shot on the north shore during the winter swell. ".repeat(60),
  };
}

/** One item larger than the entire output budget — the R4 reproduction. */
function oversizedDocument(index: number): Record<string, unknown> {
  return {
    ...indexDocument(index),
    Description: "x".repeat(20_000),
  };
}

// ------------------------------------------------------- the fake paged server

interface FakeServerOptions {
  items: Record<string, unknown>[];
  /** `list_files` / `recent_files` answer with a bare array; the other two with an items envelope. */
  bareArray: boolean;
  /** A12 / AD8: the undeployed server that ignores the page size and answers with everything. */
  honourPageSize?: boolean;
  /** CSD-628: the zero-based page the permission predicate empties while the marker still advances. */
  emptySliceIndex?: number;
  /** Envelope scalars the endpoint echoes back beside the totals — /storage/list returns the
   *  caller's own query that way (SearchObjectService.js:47, 88, 606-608). */
  envelopeScalars?: Record<string, unknown>;
}

interface ServedPage {
  requested: number | undefined;
  from: number;
  items: Record<string, unknown>[];
  nextCursor: string | undefined;
}

interface FakeServer {
  postPaged: ReturnType<typeof vi.fn>;
  served: ServedPage[];
}

/**
 * Behaves like the real backend, which is what makes this harness able to see the defect:
 * it slices by whatever page size the TOOL actually sent, mints its cursor from the LAST ITEM OF
 * THE SLICE IT RETURNED (SearchObjectService.js:71 `searchAfter = hits[hits.length-1].sort`, and
 * S3's `NextContinuationToken`), honours that cursor on the next call, and returns no cursor once
 * the fixture is exhausted (SearchObjectService.js:77-79). A connector that renders fewer items
 * than the slice therefore LOSES them on the following call.
 */
function fakePagedServer(options: FakeServerOptions): FakeServer {
  const { items, bareArray } = options;
  const honoursPageSize = options.honourPageSize !== false;
  const served: ServedPage[] = [];

  const postPaged = vi.fn(
    async (_path: string, body: Record<string, unknown>, dialect: PaginationDialect, cursor?: string) => {
      const requested =
        typeof body.pageSize === "number" ? body.pageSize : typeof body.limit === "number" ? body.limit : undefined;
      // The real client hands the tool an ENCODED cursor and decodes it on the way back in, so the
      // fake does the same: the adaptive page size travels inside that encoding (CSD-667), and a
      // harness that minted raw tokens would render the whole channel invisible to these walks.
      const from = cursor === undefined ? 0 : indexAfter(items, String(decodeCursor(cursor, dialect)));
      const size = honoursPageSize && requested ? requested : items.length;
      const scanned = items.slice(from, from + size);
      // The marker describes what the server SCANNED, not what survived the permission filter.
      const data = served.length === options.emptySliceIndex ? [] : scanned;
      const lastScanned = scanned[scanned.length - 1];
      const nextCursor =
        from + scanned.length < items.length && lastScanned
          ? encodeCursor(dialect, String(lastScanned.Key))
          : undefined;
      served.push({ requested, from, items: data, nextCursor });
      return {
        data: bareArray
          ? data
          : {
              items: data,
              totalItems: items.length,
              totalPages: Math.max(1, Math.ceil(items.length / size)),
              ...(options.envelopeScalars ?? {}),
            },
        nextCursor,
      };
    },
  );

  return { postPaged, served };
}

function indexAfter(items: Record<string, unknown>[], cursor: string): number {
  const at = items.findIndex((item) => String(item.Key) === cursor);
  if (at < 0) throw new Error(`the tool sent a cursor this server never minted: ${cursor}`);
  return at + 1;
}

function clientFor(server: FakeServer): CloudSeeClient {
  return { post: vi.fn(), postPaged: server.postPaged } as unknown as CloudSeeClient;
}

// ------------------------------------------------------------- the walk driver

interface WalkedPage {
  text: string;
  entries: Record<string, unknown>[];
  hasCursor: boolean;
}

interface WalkResult {
  pages: WalkedPage[];
  exhausted: boolean;
}

/** The rendered JSON body, with any trailing cursor hint or notice stripped. */
function renderedView(text: string): Record<string, unknown> {
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close < open) throw new Error(`tool output carries no JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(open, close + 1)) as Record<string, unknown>;
}

/** Rendered item ENTRIES — a sentinel string in the items array is a notice, not an item. */
function itemEntries(text: string): Record<string, unknown>[] {
  const items = renderedView(text).items;
  if (!Array.isArray(items)) throw new Error("tool output carries no items array");
  return items.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
}

function identityOf(tool: ListingTool, entry: Record<string, unknown>): string {
  // list_files regenerates its object id per call, so the Key is the only stable identity there.
  if (tool === "list_files") return String(entry.Key);
  return String(entry.StorageId ?? entry.Key);
}

function identitySet(tool: ListingTool, items: Record<string, unknown>[]): Set<string> {
  return new Set(items.map((item) => identityOf(tool, item)));
}

function argsFor(tool: ListingTool, pageSize?: number): Record<string, unknown> {
  if (tool === "recent_files") return pageSize === undefined ? {} : { limit: pageSize };
  const base: Record<string, unknown> = { bucketName: BUCKET };
  if (tool === "search_files") base.query = "surf";
  if (pageSize !== undefined) base.pageSize = pageSize;
  return base;
}

async function walk(
  tool: ListingTool,
  args: Record<string, unknown>,
  server: FakeServer,
  maxCalls = 80,
): Promise<WalkResult> {
  const definition = byName[tool]!;
  const client = clientFor(server);
  const pages: WalkedPage[] = [];
  let cursor: string | undefined;
  for (let call = 0; call < maxCalls; call += 1) {
    const result = await definition.handler({ ...args, ...(cursor ? { cursor } : {}) }, { client });
    const text = result.content[0]?.text ?? "";
    const next = CURSOR_PATTERN.exec(text)?.[1];
    pages.push({ text, entries: itemEntries(text), hasCursor: next !== undefined });
    if (next === undefined) return { pages, exhausted: true };
    cursor = next;
  }
  return { pages, exhausted: false };
}

function assertInvariant(tool: ListingTool, fixture: Fixture, server: FakeServer, result: WalkResult): void {
  expect(result.exhausted, `${tool}: the walk did not terminate within the call cap`).toBe(true);

  result.pages.forEach((page, index) => {
    const serverPage = server.served[index]!;
    // Clause 3 — a page the server filled must never render zero items.
    if (serverPage.items.length > 0) {
      expect(page.entries.length, `${tool}: page ${index + 1} rendered no item entries`).toBeGreaterThanOrEqual(1);
    }
    // Clause 2 — a cursor may only be emitted once the WHOLE server page has been rendered.
    if (page.hasCursor) {
      expect(
        page.entries.length,
        `${tool}: page ${index + 1} emitted a cursor after rendering ${page.entries.length} of ${serverPage.items.length} items the server returned`,
      ).toBe(serverPage.items.length);
    }
  });

  // Clause 1 — the union rendered across the walk equals the union the SERVER returned. Items a
  // permission filter removed were never returned and are not the connector's to render.
  const served = identitySet(tool, server.served.flatMap((page) => page.items));
  if (fixture.emptySliceIndex === undefined) {
    expect(served, `${tool}: the fake server itself did not serve the whole fixture`).toEqual(
      identitySet(tool, fixture.items),
    );
  }
  const rendered = new Set(result.pages.flatMap((page) => page.entries.map((entry) => identityOf(tool, entry))));
  expect(rendered, `${tool}: the walk did not render every item the server returned`).toEqual(served);
}

// ----------------------------------------------------------------- the walks

interface Fixture {
  name: string;
  items: Record<string, unknown>[];
  pageSize?: number;
  emptySliceIndex?: number;
  tools: readonly ListingTool[];
}

const FIXTURES: Fixture[] = [
  { name: "(i) 23 realistic index documents at the default page size", items: indexDocuments(23), tools: ALL_LISTING_TOOLS },
  { name: "(ii) 23 realistic index documents at pageSize 200", items: indexDocuments(23), pageSize: 200, tools: ALL_LISTING_TOOLS },
  { name: "(iii) 5 heavy items at pageSize 5", items: Array.from({ length: 5 }, (_, i) => heavyDocument(i)), pageSize: 5, tools: ALL_LISTING_TOOLS },
  { name: "(iv) 700 items on the bare-array path", items: indexDocuments(700), tools: BARE_ARRAY_TOOLS },
  {
    name: "(v) one item heavier than the whole budget, then three normal ones",
    items: [oversizedDocument(0), ...indexDocuments(3, 1)],
    tools: ALL_LISTING_TOOLS,
  },
  {
    // recent_files is excluded on purpose: /storage/recent echoes its token even when
    // exhausted, so that tool ends its walk on a short page BY CONTRACT (AD7). An empty page
    // there IS the end of the list; only the endpoints that pair a marker with a permission
    // filter can hand back an empty page with more behind it.
    name: "(vi) a middle page the permission filter empties",
    items: indexDocuments(23),
    pageSize: 5,
    emptySliceIndex: 2,
    tools: [...ENVELOPE_TOOLS, "list_files"],
  },
];

describe("listing walk — no item the server returned may become unreachable (CSD-667)", () => {
  for (const fixture of FIXTURES) {
    for (const tool of fixture.tools) {
      it(`${tool} — ${fixture.name}`, async () => {
        const server = fakePagedServer({
          items: fixture.items,
          bareArray: (BARE_ARRAY_TOOLS as readonly string[]).includes(tool),
          emptySliceIndex: fixture.emptySliceIndex,
        });
        const result = await walk(tool, argsFor(tool, fixture.pageSize), server);
        assertInvariant(tool, fixture, server, result);
      });
    }
  }

  it("keeps walking past a page the permission filter emptied, rather than reading it as the end", async () => {
    const items = indexDocuments(23);
    const server = fakePagedServer({ items, bareArray: false, emptySliceIndex: 2 });
    const result = await walk("browse_folder", argsFor("browse_folder", 5), server);

    expect(server.served[2]!.items).toHaveLength(0);
    expect(server.served.length).toBeGreaterThan(3);
    expect(result.exhausted).toBe(true);
  });
});

/**
 * S3 permits object keys up to 1024 bytes, so a drive with deeply nested folders produces items
 * whose IDENTITY alone is ~900 characters. Twenty of those cannot fit the 8 000-character budget
 * even as stubs, which is how a real drive reaches L3 at the clamped page size. Every fixture
 * above resolves to L1 or L2, so without this shape the whole L3 branch — and the cursor gate
 * that depends on it — is never exercised at the tool layer.
 */
function longKeyDocument(index: number): Record<string, unknown> {
  const key = `${"deep-folder-segment/".repeat(45)}file-${String(index).padStart(3, "0")}.bin`;
  return {
    Name: key,
    Key: key,
    Path: key,
    Size: 4096 + index,
    LastModified: "2026-08-14T03:21:55.000Z",
    IsFolder: false,
    StorageId: `937896d1f42416222e53d07baa80eab19af321d8ff6eb1a056da08b0f7ab${String(index).padStart(4, "0")}`,
    StorageClass: "STANDARD",
    Status: "Ready",
  };
}

/**
 * The shape `FIRST_PAGE_ITEMS` is calibrated against: an 85-character descriptive file name
 * under a nested path (a 125-character `Key` — `list_files` publishes the full path), carrying the
 * Project and Category metadata a drive in use fills in. It is the heaviest item an ordinary
 * listing produces, and it costs 569 rendered characters against `surf-000.jpg`'s 321.
 */
function descriptiveDocument(index: number): Record<string, unknown> {
  const name = `Quarterly Business Review ${String(index).padStart(3, "0")} - FY2026 Q3 EMEA regional approved summary (final).xlsx`;
  const key = `Extract/FY2026 Q3 exports/sub-folder-${String(index % 70).padStart(2, "0")}/${name}`;
  return {
    ...indexDocument(index),
    Name: name,
    Key: key,
    Path: key,
    Project: "Marketing",
    Category: "Quarterly reports",
  };
}

// CSD-667. `FIRST_PAGE_ITEMS` is the one page size chosen without evidence — the first call of a
// walk has measured nothing — so it must at least render a whole page for realistic items: every
// item in full, nothing abbreviated, and a cursor to the next page. Nothing asserted that. The
// seed was previously derived from 12-character names (`surf-000.jpg`), so at 20 a drive with
// descriptive or nested names answered the FIRST call with identity-only stubs and NO cursor. The
// fixture is deliberately the heaviest realistic item: a seed proved on a lean one is the defect.
describe("a full first page of realistically named items renders whole (CSD-667)", () => {
  for (const tool of ALL_LISTING_TOOLS) {
    it(`${tool} renders every item of a first page in full, with a cursor`, async () => {
      const items = Array.from({ length: FIRST_PAGE_ITEMS * 3 }, (_, index) => descriptiveDocument(index));
      expect(String(items[0]!.Name).length, "the fixture must keep the long names it is calibrated for").toBe(85);
      expect(String(items[0]!.Key).length, "the fixture must keep the nested key it is calibrated for").toBe(125);

      const server = fakePagedServer({ items, bareArray: (BARE_ARRAY_TOOLS as readonly string[]).includes(tool) });
      const result = await byName[tool]!.handler(argsFor(tool), { client: clientFor(server) });
      const text = result.content[0]?.text ?? "";

      expect(server.served[0]!.requested, "the tool must send the calibrated page size").toBe(FIRST_PAGE_ITEMS);
      expect(itemEntries(text), "the whole page must be rendered").toHaveLength(FIRST_PAGE_ITEMS);
      expect(renderedView(text).shown).toBe(FIRST_PAGE_ITEMS);
      expect(renderedView(text).abbreviated, "not one item may be reduced to a stub").toBeUndefined();
      expect(text).not.toContain(ABBREVIATED_ITEM_NOTICE);
      expect(text).not.toContain(SMALLER_PAGE_RETRY_NOTICE);
      // L1 means the page is complete, so the walk goes on without the caller shrinking anything.
      expect(CURSOR_PATTERN.test(text), "a whole page must hand back the cursor to the next one").toBe(true);
      // Every item keeps the fields a listing is read FOR — a stub carries identity only.
      const first = itemEntries(text)[0]!;
      expect(first.Size).toBeDefined();
      expect(first.LastModified).toBeDefined();
    });
  }
});

/** An item whose whole projected form is a handful of fields — a drive of loose files at the
 *  root, with no metadata and no folder tree. ~100 rendered characters against the seed's 569. */
function leanDocument(index: number): Record<string, unknown> {
  return { Name: `a-${String(index).padStart(3, "0")}.txt`, Key: `a-${String(index).padStart(3, "0")}.txt`, Size: 40 };
}

/**
 * CSD-667. A fixed page size is a claim about the caller's data, and the connector cannot make
 * one: `Project`, `Category` and `Description` are user-entered and unbounded, and folder trees go
 * deeper than any drive this file was measured on. So only the FIRST call guesses; after that each
 * page is sized from the cost of the page before it, on the caller's own items.
 *
 * The evidence is the cost of the items IN FULL. A page that had to abbreviate is CHEAP — stubs
 * are short — so a loop that read the rendered length back would recommend repeating the page of
 * stubs it was supposed to escape. The heavy case below is exactly that trap: page one renders
 * abbreviated, and the page after it must come back whole.
 */
describe("the page size adapts to the caller's items, in both directions (CSD-667)", () => {
  it("shrinks the page after a first page of heavy items, until the items render whole", async () => {
    const items = Array.from({ length: 40 }, (_, index) => heavyDocument(index));
    const server = fakePagedServer({ items, bareArray: false });

    const result = await walk("browse_folder", argsFor("browse_folder"), server);

    expect(server.served[0]!.requested, "the first call has measured nothing and uses the seed").toBe(FIRST_PAGE_ITEMS);
    expect(server.served[1]!.requested, "a page of heavy items must buy a smaller next page").toBeLessThan(
      FIRST_PAGE_ITEMS,
    );
    expect(result.pages[0]!.text, "the seed is too large for these items — page one abbreviates").toContain(
      ABBREVIATED_ITEM_NOTICE,
    );
    expect(result.pages[1]!.text, "the measured page must render its items whole").not.toContain(
      ABBREVIATED_ITEM_NOTICE,
    );
    assertInvariant("browse_folder", { name: "40 heavy items", items, tools: ["browse_folder"] }, server, result);
  });

  it("grows the page after a first page of light items, instead of paying for round trips", async () => {
    const items = Array.from({ length: 200 }, (_, index) => leanDocument(index));
    const server = fakePagedServer({ items, bareArray: false });

    const result = await walk("browse_folder", argsFor("browse_folder"), server);

    expect(server.served[0]!.requested).toBe(FIRST_PAGE_ITEMS);
    expect(server.served[1]!.requested, "lean items leave budget the walk should be spending").toBeGreaterThan(
      FIRST_PAGE_ITEMS,
    );
    // Growth is only worth having if the bigger page still renders whole.
    expect(result.pages[1]!.text).not.toContain(ABBREVIATED_ITEM_NOTICE);
    expect(result.pages[1]!.text).not.toContain(SMALLER_PAGE_RETRY_NOTICE);
    assertInvariant("browse_folder", { name: "200 lean items", items, tools: ["browse_folder"] }, server, result);
  });

  it("carries the measured size in the cursor, where it is ours and opaque to the model", async () => {
    const items = Array.from({ length: 40 }, (_, index) => leanDocument(index));
    const server = fakePagedServer({ items, bareArray: false });

    const text = (await byName["browse_folder"]!.handler(argsFor("browse_folder"), { client: clientFor(server) }))
      .content[0]?.text ?? "";
    const cursor = CURSOR_PATTERN.exec(text)?.[1];

    expect(readPageSizeHint(cursor), "the next call's page size travels inside the cursor").toBeGreaterThan(
      FIRST_PAGE_ITEMS,
    );
    expect(text, "the hint is connector-internal — the tool contract must not grow a field").not.toContain("pageSize");
  });

  // Every tool, both payload shapes: an adaptive size that only works on the envelope path would
  // leave list_files and recent_files paging at the seed for ever.
  for (const tool of ALL_LISTING_TOOLS) {
    it(`${tool} reaches every item while the page size moves under it`, async () => {
      const items = Array.from({ length: 120 }, (_, index) =>
        index % 3 === 0 ? heavyDocument(index) : leanDocument(index),
      );
      const server = fakePagedServer({ items, bareArray: (BARE_ARRAY_TOOLS as readonly string[]).includes(tool) });

      const result = await walk(tool, argsFor(tool), server);

      const sizes = new Set(server.served.map((page) => page.requested));
      expect(sizes.size, "this fixture must actually move the page size, or it proves nothing").toBeGreaterThan(1);
      assertInvariant(tool, { name: "mixed weights", items, tools: [tool] }, server, result);
    });
  }
});

// CSD-667 clause 2, at the TOOL layer. `format.test.ts` proves the renderer REPORTS an incomplete
// page; nothing proved that read.ts ACTS on the report. Without this block every one of the four
// `render.complete ? nextCursor : undefined` gates can be replaced by a bare `nextCursor` and the
// whole suite stays green — i.e. the connector would hand back a cursor that skips the 17 items it
// could not render, which is the exact defect this ticket exists to remove.
describe("an incomplete page never hands back a cursor (CSD-667 clause 2)", () => {
  for (const tool of ALL_LISTING_TOOLS) {
    it(`${tool} withholds the server's cursor when the page could not be rendered whole`, async () => {
      const items = Array.from({ length: 40 }, (_, index) => longKeyDocument(index));
      const server = fakePagedServer({
        items,
        bareArray: (BARE_ARRAY_TOOLS as readonly string[]).includes(tool),
      });
      const client = clientFor(server);

      const result = await byName[tool]!.handler(argsFor(tool, 20), { client });
      const text = result.content[0]?.text ?? "";

      // The server DID offer a continuation token, so withholding it is a decision, not an accident.
      expect(server.served[0]!.nextCursor, "the fake server must offer a cursor for this to mean anything").toBeDefined();
      const rendered = itemEntries(text).length;
      expect(rendered, "the page must render at least one item (clause 3)").toBeGreaterThanOrEqual(1);
      expect(rendered, "this fixture only tests what it should if the page is genuinely partial").toBeLessThan(
        server.served[0]!.items.length,
      );
      expect(CURSOR_PATTERN.test(text), `${tool} emitted a cursor over ${server.served[0]!.items.length - rendered} unrendered item(s)`).toBe(false);
      expect(text, "clause 3 — a partial page must name the action that moves the walk on").toContain(
        SMALLER_PAGE_RETRY_NOTICE,
      );
    });
  }
});

// CSD-667. /storage/list echoes the caller's own query back as an ENVELOPE SCALAR (`query:
// encryptedQuery`, SearchObjectService.js:47, 88, 606-608), and `encryptQuery` encrypts the whole
// DSL, so that scalar grows with the keyword — which search_files' schema (`z.string().min(1)`,
// no maximum) does not bound. Driven through the real tool with an ~8 000-character query the
// renderer answered 8 073 characters carrying 0 of 20 identities, no cursor, no retry instruction
// and JSON that does not parse: the envelope alone overran the budget, so the ladder fell through
// to the raw character cut and the cut took every item entry with it — a dead end with 40 items
// still behind it. Identity comes first for the ENVELOPE too: it describes the result set, so it
// may never consume the budget the result set itself needs.
describe("an oversized envelope scalar must not cost the page its items (CSD-667)", () => {
  const ENCRYPTED_QUERY = `enc:${"A1b2C3d4".repeat(1_000)}`;

  it("search_files still renders every identity of the page, and still offers a way forward", async () => {
    const items = indexDocuments(60);
    const server = fakePagedServer({ items, bareArray: false, envelopeScalars: { query: ENCRYPTED_QUERY } });
    const client = clientFor(server);

    const result = await byName["search_files"]!.handler(argsFor("search_files"), { client });
    const text = result.content[0]?.text ?? "";

    expect(() => renderedView(text), "the render must be parseable JSON, not a mid-string cut").not.toThrow();
    expect(itemEntries(text).length, "not one identity survived the envelope").toBe(server.served[0]!.items.length);
    expect(
      CURSOR_PATTERN.test(text) || text.includes(SMALLER_PAGE_RETRY_NOTICE),
      "clause 3 — the page must either reach the rest or name the action that does",
    ).toBe(true);
    // The scalar is cut, but visibly: a silent truncation is the defect this ticket removes.
    expect(String(renderedView(text).query)).toContain(TRUNCATED_SCALAR_NOTICE);
  });

  it("search_files still reaches every item across the walk", async () => {
    const items = indexDocuments(60);
    const server = fakePagedServer({ items, bareArray: false, envelopeScalars: { query: ENCRYPTED_QUERY } });

    const result = await walk("search_files", argsFor("search_files"), server);

    result.pages.forEach((page, index) => {
      expect(page.entries.length, `page ${index + 1} rendered no item entries`).toBeGreaterThanOrEqual(1);
    });
    assertInvariant(
      "search_files",
      { name: "an 8 000-character envelope scalar", items, tools: ["search_files"] },
      server,
      result,
    );
  });
});

// CSD-667 clause 3 — "a CONCRETE, EFFECTIVE action". An L3 page withholds the cursor and tells the
// caller to re-ask at the same cursor with a smaller page size. That instruction is only honest if
// following it actually finishes the walk; if it did not, L3 would be a dead end dressed up as a
// way forward, and the invariant would rest on the group C clamp rather than on the ladder.
describe("following the L3 retry instruction completes the walk", () => {
  it("browse_folder reaches every item by halving the page size when a page cannot be rendered whole", async () => {
    const items = Array.from({ length: 40 }, (_, index) => longKeyDocument(index));
    const server = fakePagedServer({ items, bareArray: false });
    const client = clientFor(server);

    const rendered = new Set<string>();
    let cursor: string | undefined;
    let pageSize = 20;
    let retries = 0;

    for (let call = 0; call < 80; call += 1) {
      const args = { ...argsFor("browse_folder", pageSize), ...(cursor ? { cursor } : {}) };
      const text = (await byName["browse_folder"]!.handler(args, { client })).content[0]?.text ?? "";
      const entries = itemEntries(text);
      expect(entries.length, "no page may render zero items").toBeGreaterThanOrEqual(1);
      const next = CURSOR_PATTERN.exec(text)?.[1];

      if (next === undefined && text.includes(SMALLER_PAGE_RETRY_NOTICE)) {
        // The instruction, followed literally: SAME cursor, smaller page size. Nothing from this
        // page is banked — it was incomplete, which is exactly why no cursor was offered.
        expect(pageSize, "the retry chain must terminate before pageSize reaches 0").toBeGreaterThan(1);
        pageSize = Math.max(1, Math.floor(pageSize / 2));
        retries += 1;
        continue;
      }

      entries.forEach((entry) => rendered.add(identityOf("browse_folder", entry)));
      if (next === undefined) break;
      cursor = next;
    }

    expect(retries, "the fixture must actually drive the tool into L3, or this proves nothing").toBeGreaterThanOrEqual(1);
    expect(rendered).toEqual(identitySet("browse_folder", items));
  });
});

// A12 / AD8. Max releases the connector without waiting for the prod storage-api deploy, so during
// that window this path is the only thing keeping list_files honest: it cannot page inside one S3
// page, so clause 1 is knowingly unsatisfiable and the obligation reduces to clause 3 — tell the
// truth and name an action that does work.
describe("list_files against a server that does not honour the page size", () => {
  it("renders a budgeted slice, states the shortfall, withholds the cursor and names the alternative", async () => {
    const items = indexDocuments(700);
    const server = fakePagedServer({ items, bareArray: true, honourPageSize: false });
    const client = clientFor(server);

    const result = await byName["list_files"]!.handler({ bucketName: BUCKET }, { client });
    const text = result.content[0]?.text ?? "";

    expect(itemEntries(text).length).toBeGreaterThanOrEqual(1);
    // Plan §5.4 — a fixed string is asserted whole, so a reworded notice cannot pass on fragments.
    // 700 objects came back for what the clamp put on the wire (default 50 → FIRST_PAGE_ITEMS).
    // The page size is interpolated from the constant, not written out, so recalibrating it stays a
    // one-line change — it was 20 until the constant was measured against realistic key lengths.
    expect(text).toContain(
      `⚠ This drive returned 700 objects for a requested page size of ${FIRST_PAGE_ITEMS} — it did not honour the page size. ` +
        `This response covers at most the first ${FIRST_PAGE_ITEMS} of them (see "shown" for how many were rendered); the rest ` +
        'cannot be reached through this tool, and no pagination cursor is offered because following it would ' +
        'skip them. Use browse_folder or search_files for a complete listing of this drive.',
    );
    expect(CURSOR_PATTERN.test(text)).toBe(false);
  });
});
