import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import { SMALLER_PAGE_RETRY_NOTICE, TRUNCATED_SCALAR_NOTICE } from "../../src/tools/format";
import { decodeCursor, encodeCursor, readPageSizeHint, type PaginationDialect } from "../../src/client/pagination";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-667, tester round. Three earlier rounds each closed the defect in one dimension and each
// declared the next one structurally unreachable: item count, then scalar value, then key name and
// envelope total. This file attacks the shapes that closed the previous rounds, at the sizes
// production actually permits rather than the sizes the fixtures happen to use — a 1 024-byte S3
// key (the hard S3 maximum), an envelope four times the budget, items that carry no identity at
// all, and the adaptive page size fed by items small enough to push it past the schema bound.
//
// Every case is held to the same three clauses (analysis §2): the union rendered across a walk
// equals the union the server returned; a cursor appears only on a page rendered whole; and no
// page is a dead end — it renders at least one item and either reaches the rest or names the
// action that does.

const BUCKET = "cloudsee-demo";
const CURSOR_PATTERN = /cursor="([^"]+)"/;
const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));

const ENVELOPE_TOOLS = ["browse_folder", "search_files"] as const;
const BARE_ARRAY_TOOLS = ["list_files", "recent_files"] as const;
const ALL_LISTING_TOOLS = [...ENVELOPE_TOOLS, ...BARE_ARRAY_TOOLS] as const;
type ListingTool = (typeof ALL_LISTING_TOOLS)[number];

function isBareArrayTool(tool: ListingTool): boolean {
  return (BARE_ARRAY_TOOLS as readonly string[]).includes(tool);
}

function argsFor(tool: ListingTool, pageSize?: number): Record<string, unknown> {
  if (tool === "recent_files") return pageSize === undefined ? {} : { limit: pageSize };
  const base: Record<string, unknown> = { bucketName: BUCKET };
  if (tool === "search_files") base.query = "surf";
  if (pageSize !== undefined) base.pageSize = pageSize;
  return base;
}

function renderedView(text: string): Record<string, unknown> {
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close < open) throw new Error(`tool output carries no JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(open, close + 1)) as Record<string, unknown>;
}

/** Rendered item ENTRIES — a sentinel string inside the items array is a notice, not an item. */
function itemEntries(text: string): Record<string, unknown>[] {
  const items = renderedView(text).items;
  if (!Array.isArray(items)) throw new Error("tool output carries no items array");
  return items.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
}

/** Clause 3, asserted on a single page: parseable, at least one item, and — unless this is the
 *  page that ends the list, where there is nothing left to reach — a way onward. */
function expectNoDeadEnd(label: string, text: string, isFinalPage = false): void {
  expect(() => renderedView(text), `${label}: the render must parse, not end mid-string`).not.toThrow();
  expect(itemEntries(text).length, `${label}: the page rendered no item entries`).toBeGreaterThanOrEqual(1);
  if (!isFinalPage) {
    expect(
      CURSOR_PATTERN.test(text) || text.includes(SMALLER_PAGE_RETRY_NOTICE),
      `${label}: the page neither reaches the rest nor names the action that does`,
    ).toBe(true);
  }
  expect(text, `${label}: the listing path reached the raw character cut`).not.toContain("output truncated at");
}

function clientReturning(data: unknown, nextCursor: string | undefined): CloudSeeClient {
  return { post: vi.fn(), postPaged: vi.fn(async () => ({ data, nextCursor })) } as unknown as CloudSeeClient;
}

// ------------------------------------------------------------ the fake paged server

interface ServedPage {
  requested: number | undefined;
  items: Record<string, unknown>[];
  nextCursor: string | undefined;
}

interface FakeServer {
  postPaged: ReturnType<typeof vi.fn>;
  served: ServedPage[];
}

/** Slices by the page size the TOOL sent and mints its cursor from the last item of the slice,
 *  as SearchObjectService and S3's NextContinuationToken both do. A connector that renders fewer
 *  items than the slice therefore loses the remainder on the following call. */
function fakePagedServer(items: Record<string, unknown>[], bareArray: boolean): FakeServer {
  const served: ServedPage[] = [];
  const postPaged = vi.fn(
    async (_path: string, body: Record<string, unknown>, dialect: PaginationDialect, cursor?: string) => {
      const requested =
        typeof body.pageSize === "number" ? body.pageSize : typeof body.limit === "number" ? body.limit : undefined;
      const from = cursor === undefined ? 0 : indexAfter(items, String(decodeCursor(cursor, dialect)));
      const slice = items.slice(from, from + (requested ?? items.length));
      const last = slice[slice.length - 1];
      const nextCursor =
        from + slice.length < items.length && last ? encodeCursor(dialect, String(last.Key)) : undefined;
      served.push({ requested, items: slice, nextCursor });
      return {
        data: bareArray ? slice : { items: slice, totalItems: items.length, totalPages: 1 },
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

/** Walks the tool to exhaustion, following the L3 retry instruction when one is given, and
 *  returns every identity the walk rendered. Halving mirrors what the sentinel asks for. */
async function walkFollowingInstructions(
  tool: ListingTool,
  server: FakeServer,
  startingPageSize?: number,
): Promise<{ rendered: Set<string>; pages: string[]; exhausted: boolean }> {
  const definition = byName[tool]!;
  const client = clientFor(server);
  const rendered = new Set<string>();
  const pages: string[] = [];
  let cursor: string | undefined;
  let pageSize = startingPageSize;

  for (let call = 0; call < 120; call += 1) {
    const args = { ...argsFor(tool, pageSize), ...(cursor ? { cursor } : {}) };
    const text = (await definition.handler(args, { client })).content[0]?.text ?? "";
    pages.push(text);
    const next = CURSOR_PATTERN.exec(text)?.[1];

    if (next === undefined && text.includes(SMALLER_PAGE_RETRY_NOTICE)) {
      expect(pageSize ?? Number.POSITIVE_INFINITY, "the retry chain must terminate above a page of 1").toBeGreaterThan(1);
      pageSize = Math.max(1, Math.floor((pageSize ?? 13) / 2));
      continue;
    }
    itemEntries(text).forEach((entry) => rendered.add(String(entry.Key)));
    if (next === undefined) return { rendered, pages, exhausted: true };
    cursor = next;
  }
  return { rendered, pages, exhausted: false };
}

// ------------------------------------------------------------------- the fixtures

/** An object key at the hard S3 maximum of 1 024 bytes — the largest identity a real drive can
 *  produce, and the one the abbreviated stub promises to publish whole. */
function maximumKeyDocument(index: number): Record<string, unknown> {
  const suffix = `/file-${String(index).padStart(4, "0")}.bin`;
  const key = `${"deep-folder-segment/".repeat(60)}`.slice(0, 1024 - suffix.length) + suffix;
  return {
    Name: `file-${String(index).padStart(4, "0")}.bin`,
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

/** The smallest item a listing can carry — an identity and nothing else. It is what pushes the
 *  measured page size upward, so it is what tests the ceiling the schema publishes. */
function minimalDocument(index: number): Record<string, unknown> {
  return { Key: `${index}` };
}

describe("the S3 maximum key length (CSD-667, tester round)", () => {
  it("keeps a 1 024-byte key whole — a cut key cannot be passed to get_file_metadata", async () => {
    const document = maximumKeyDocument(0);
    expect(String(document.Key)).toHaveLength(1024);

    const client = clientReturning({ items: [document], totalItems: 1 }, undefined);
    const text = (await byName["search_files"]!.handler(argsFor("search_files"), { client })).content[0]?.text ?? "";

    expect(String(itemEntries(text)[0]!.Key), "the identity of the item was shortened").toBe(document.Key);
  });

  for (const tool of ALL_LISTING_TOOLS) {
    it(`${tool} reaches every item of a drive whose keys are all 1 024 bytes`, async () => {
      const items = Array.from({ length: 30 }, (_, index) => maximumKeyDocument(index));
      const server = fakePagedServer(items, isBareArrayTool(tool));

      const walk = await walkFollowingInstructions(tool, server, 20);

      expect(walk.exhausted, `${tool}: the walk did not terminate`).toBe(true);
      walk.pages.forEach((text, index) =>
        expectNoDeadEnd(`${tool} page ${index + 1}`, text, index === walk.pages.length - 1),
      );
      expect(walk.rendered, `${tool}: an item at the S3 key maximum became unreachable`).toEqual(
        new Set(items.map((item) => String(item.Key))),
      );
    });
  }
});

describe("an envelope larger than the whole budget, on the page that can least afford it", () => {
  // Rounds 2 and 3 both succeeded here: the envelope was bounded in one dimension at a time, and
  // each time a shape was left that consumed the budget the items needed. This case combines all
  // three at four times the size ever measured — long keys, long values, many of both — on a page
  // whose single item is itself heavier than the budget, which is where the ladder has the least
  // left to give back.
  it("renders the item, states the cut and never reaches the character truncation", async () => {
    const scalars = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`echoed${"Field".repeat(300)}${index}`, "v".repeat(2_000)]),
    );
    const oversizedItem = { ...maximumKeyDocument(0), Description: "x".repeat(32_000) };
    const client = clientReturning({ items: [oversizedItem], totalItems: 40, totalPages: 4, ...scalars }, "server-cursor");

    const text = (await byName["search_files"]!.handler(argsFor("search_files"), { client })).content[0]?.text ?? "";
    const view = renderedView(text);

    expectNoDeadEnd("a 32 000-character envelope over an oversized item", text);
    expect(view.totalItems, "the count that reveals a partial page was crowded out").toBe(40);
    expect(view.totalPages).toBe(4);
    expect(view.droppedFields, "what the budget could not carry must be counted").toBeGreaterThan(0);
    expect(String(itemEntries(text)[0]!.Key), "the item's identity was cut").toBe(oversizedItem.Key);
  });

  it("still forwards the cursor, because the whole page was rendered", async () => {
    const scalars = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`echoedField${index}`, "v".repeat(2_000)]),
    );
    const client = clientReturning(
      { items: [maximumKeyDocument(0), maximumKeyDocument(1)], totalItems: 40, ...scalars },
      "server-cursor",
    );

    const text = (await byName["search_files"]!.handler(argsFor("search_files"), { client })).content[0]?.text ?? "";

    expect(itemEntries(text)).toHaveLength(2);
    expect(CURSOR_PATTERN.exec(text)?.[1], "a page rendered whole must hand back its cursor").toBe("server-cursor");
    expect(String(renderedView(text).echoedField0)).toContain(TRUNCATED_SCALAR_NOTICE);
  });
});

describe("items the renderer cannot abbreviate, because they carry no identity", () => {
  // `abbreviatedView` returns undefined for anything without a Name or a Key, so the stub tier has
  // nothing to fall back to. A page of those must still parse and still render, rather than
  // pricing its items at Infinity and falling through to a dead end.
  it("renders a page of items that are bare scalars, and still offers a way forward", async () => {
    const items = [..."abcdefghij"].map((letter) => letter.repeat(3_000));
    const client = clientReturning({ items, totalItems: 10 }, "server-cursor");

    const text = (await byName["browse_folder"]!.handler(argsFor("browse_folder"), { client })).content[0]?.text ?? "";

    expect(() => renderedView(text), "the render must parse").not.toThrow();
    const rendered = renderedView(text).items as unknown[];
    expect(rendered.length, "a page with no renderable identity still renders something").toBeGreaterThanOrEqual(1);
    expect(text).not.toContain("output truncated at");
  });

  it("renders a page of nulls without crashing or claiming items it did not show", async () => {
    const client = clientReturning({ items: [null, null, null], totalItems: 3 }, "server-cursor");

    const text = (await byName["browse_folder"]!.handler(argsFor("browse_folder"), { client })).content[0]?.text ?? "";
    const view = renderedView(text);

    expect(view.shown, "shown must count what the items array actually carries").toBe(3);
    expect(view.items).toEqual([null, null, null]);
    expect(CURSOR_PATTERN.test(text), "nothing was left behind, so the walk goes on").toBe(true);
  });
});

describe("the measured page size can never leave the bounds the schema publishes", () => {
  // The hint is minted from the connector's own measurement, so nothing upstream validates it.
  // Items small enough to measure a page of hundreds are ordinary — a drive of loose files named
  // by number — and the value on the wire must still be one the tool's own schema permits.
  it("never sends more than the published maximum, however light the previous page was", async () => {
    const items = Array.from({ length: 600 }, (_, index) => minimalDocument(index));
    const server = fakePagedServer(items, false);
    const client = clientFor(server);

    const first = (await byName["browse_folder"]!.handler(argsFor("browse_folder"), { client })).content[0]?.text ?? "";
    const cursor = CURSOR_PATTERN.exec(first)?.[1];
    expect(readPageSizeHint(cursor), "items this light must measure a page above the schema bound").toBeGreaterThan(200);

    await byName["browse_folder"]!.handler({ ...argsFor("browse_folder"), cursor }, { client });

    const sent = server.served[1]!.requested!;
    expect(sent, "the connector sent a page size its own schema rejects").toBeLessThanOrEqual(200);
    expect(sent, "the page size must stay a whole page").toBeGreaterThanOrEqual(1);
  });

  // An item heavier than the whole budget measures a page of less than one. A hint of zero would
  // be a walk that asks for nothing for ever, so the floor is what keeps the next call moving.
  it("never measures less than one item, however heavy the page it measured", async () => {
    const heavy = { ...maximumKeyDocument(0), Description: "x".repeat(60_000) };
    const client = clientReturning({ items: [heavy], totalItems: 40 }, encodeCursor("nextPage", "last-key"));

    const text = (await byName["browse_folder"]!.handler(argsFor("browse_folder"), { client })).content[0]?.text ?? "";
    const cursor = CURSOR_PATTERN.exec(text)?.[1];

    expect(cursor, "the whole page was rendered — as a stub, but rendered — so the cursor is due").toBeDefined();
    expect(readPageSizeHint(cursor), "a page of zero items is not a page").toBe(1);
  });
});
