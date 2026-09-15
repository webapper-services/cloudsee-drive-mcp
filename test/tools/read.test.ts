import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import { FIRST_PAGE_ITEMS } from "../../src/tools/format";
import { encodeCursor, withPageSizeHint } from "../../src/client/pagination";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-662 F7. The index stores a folder's `Parent` with its trailing slash and the folder
// filter is an exact term match, so `path: "Birds"` matched zero documents and the endpoint
// honestly answered `totalItems: 0` — a silent "your folder is empty" for a folder with 10
// files. The read path must apply the same normaliser the write path already used.

const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));

function pagedClient(postPaged: ReturnType<typeof vi.fn>): CloudSeeClient {
  return { post: vi.fn(), postPaged } as unknown as CloudSeeClient;
}

function emptyPage(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ data: { items: [], totalItems: 0 }, nextCursor: undefined });
}

function outboundBody(postPaged: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [path, body] = postPaged.mock.calls[0] as [string, Record<string, unknown>];
  expect(path).toBe("/storage/list");
  return body;
}

describe("browse_folder folder path normalisation", () => {
  const tool = byName["browse_folder"]!;

  it("appends the trailing slash the index requires", async () => {
    const postPaged = emptyPage();
    await tool.handler({ bucketName: "cloudsee-demo", path: "Birds" }, { client: pagedClient(postPaged) });
    expect(outboundBody(postPaged).dirPath).toBe("Birds/");
  });

  it("leaves a path that already ends in a slash untouched", async () => {
    const postPaged = emptyPage();
    await tool.handler({ bucketName: "cloudsee-demo", path: "Birds/Owls/" }, { client: pagedClient(postPaged) });
    expect(outboundBody(postPaged).dirPath).toBe("Birds/Owls/");
  });

  it("keeps an empty path empty — the server maps that to the drive root itself", async () => {
    const postPaged = emptyPage();
    await tool.handler({ bucketName: "cloudsee-demo", path: "" }, { client: pagedClient(postPaged) });
    expect(outboundBody(postPaged).dirPath).toBe("");
  });

  it("sends an empty path when the caller omits it", async () => {
    const postPaged = emptyPage();
    await tool.handler({ bucketName: "cloudsee-demo" }, { client: pagedClient(postPaged) });
    expect(outboundBody(postPaged).dirPath).toBe("");
  });

  it("normalises a nested path without touching the rest of the request", async () => {
    const postPaged = emptyPage();
    await tool.handler(
      { bucketName: "cloudsee-demo", path: "Birds/Owls", sortOption: "name_desc", pageSize: 3 },
      { client: pagedClient(postPaged) },
    );
    expect(outboundBody(postPaged)).toEqual({
      bucketName: "cloudsee-demo",
      dirPath: "Birds/Owls/",
      sortOption: "name_desc",
      pageSize: 3,
    });
  });
});

describe("search_files folder path normalisation", () => {
  const tool = byName["search_files"]!;

  it("appends the trailing slash to the search scope", async () => {
    const postPaged = emptyPage();
    await tool.handler({ bucketName: "cloudsee-demo", query: "jpg", path: "Birds" }, { client: pagedClient(postPaged) });
    expect(outboundBody(postPaged).dirPath).toBe("Birds/");
  });

  it("keeps an empty scope empty", async () => {
    const postPaged = emptyPage();
    await tool.handler({ bucketName: "cloudsee-demo", query: "jpg", path: "" }, { client: pagedClient(postPaged) });
    expect(outboundBody(postPaged).dirPath).toBe("");
  });

  it("sends an empty scope when the caller omits the path", async () => {
    const postPaged = emptyPage();
    await tool.handler({ bucketName: "cloudsee-demo", query: "jpg" }, { client: pagedClient(postPaged) });
    expect(outboundBody(postPaged).dirPath).toBe("");
  });

  it("rejects an empty query before calling the API", async () => {
    const postPaged = emptyPage();
    await expect(
      tool.handler({ bucketName: "cloudsee-demo", query: "", path: "Birds" }, { client: pagedClient(postPaged) }),
    ).rejects.toThrow();
    expect(postPaged).not.toHaveBeenCalled();
  });
});

// CSD-662 F2, through the tool rather than the formatter: browse_folder(pageSize:200) on a
// 21-item drive root rendered 7 items and cut the response mid-structure, taking
// `totalItems`/`totalPages` with it — the caller could not tell a partial list from a whole one.
describe("listing tools keep the result-set totals when the page cannot be rendered whole", () => {
  const oversizedListing = {
    items: Array.from({ length: 21 }, (_, index) => ({
      Name: `surf-${String(index).padStart(3, "0")}.jpg`,
      Metadata: "N/A placeholder written by the indexer. ".repeat(12),
    })),
    totalItems: 21,
    totalPages: 11,
  };

  for (const [toolName, args] of [
    ["browse_folder", { bucketName: "cloudsee-demo", pageSize: 200 }],
    ["search_files", { bucketName: "cloudsee-demo", query: "surf", pageSize: 200 }],
    ["list_files", { bucketName: "cloudsee-demo" }],
  ] as const) {
    it(`${toolName} still reports totalItems and a shown count`, async () => {
      const postPaged = vi.fn().mockResolvedValue({ data: oversizedListing, nextCursor: undefined });
      const res = await byName[toolName]!.handler(args, { client: pagedClient(postPaged) });

      const text = res.content[0]?.text ?? "";
      expect(text).toContain('"totalItems": 21');
      expect(text).toContain('"totalPages": 11');
      expect(text).toMatch(/"shown": \d+/);
    });
  }
});

describe("recent_files pagination dialect", () => {
  const tool = byName["recent_files"]!;

  it("asks postPaged for the `nextPage` dialect, matching the published registry row", async () => {
    const postPaged = vi.fn().mockResolvedValue({ data: [], nextCursor: undefined });
    await tool.handler({ limit: 2 }, { client: pagedClient(postPaged) });
    const [path, body, dialect] = postPaged.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(path).toBe("/storage/recent");
    expect(body).toEqual({ limit: 2 });
    expect(dialect).toBe("nextPage");
  });

  it("withholds a cursor when the page came back short — the endpoint echoes its token forever", async () => {
    const postPaged = vi.fn().mockResolvedValue({ data: [{ Name: "a.txt" }], nextCursor: "cursor-from-a-short-page" });
    const res = await tool.handler({ limit: 2 }, { client: pagedClient(postPaged) });
    expect(res.content[0]?.text).not.toContain("cursor-from-a-short-page");
  });

  // CSD-667 R2, the highest-risk line in this change. `limit` is both the value sent and the
  // value `hasMore` is compared against; clamping only the value sent would make `hasMore`
  // permanently false and truncate the walk at page one.
  it("still advertises a next page when the CLAMPED request came back full", async () => {
    const data = Array.from({ length: FIRST_PAGE_ITEMS }, (_, index) => ({ Name: `file-${index}.txt` }));
    const postPaged = vi.fn().mockResolvedValue({ data, nextCursor: "cursor-from-a-full-page" });
    const res = await tool.handler({ limit: 200 }, { client: pagedClient(postPaged) });
    expect((postPaged.mock.calls[0] as [string, Record<string, unknown>])[1].limit).toBe(FIRST_PAGE_ITEMS);
    expect(res.content[0]?.text).toContain("cursor-from-a-full-page");
  });
});

// CSD-667 T4. Asking for 200 used to render 3 items and hand back a cursor that skipped 197.
// The FIRST call of a walk has measured nothing yet, so it sends the `FIRST_PAGE_ITEMS` seed:
// the caller receives all 200 across truthful calls instead of 3 and a lie.
describe("listing tools clamp the outbound page size to what the renderer can show", () => {
  for (const [toolName, args, field] of [
    ["browse_folder", { bucketName: "cloudsee-demo", pageSize: 200 }, "pageSize"],
    ["search_files", { bucketName: "cloudsee-demo", query: "surf", pageSize: 200 }, "pageSize"],
    ["list_files", { bucketName: "cloudsee-demo", pageSize: 200 }, "pageSize"],
    ["recent_files", { limit: 200 }, "limit"],
  ] as const) {
    it(`${toolName} sends at most ${FIRST_PAGE_ITEMS}`, async () => {
      const postPaged = vi.fn().mockResolvedValue({ data: [], nextCursor: undefined });
      await byName[toolName]!.handler(args, { client: pagedClient(postPaged) });
      const [, body] = postPaged.mock.calls[0] as [string, Record<string, unknown>];
      expect(body[field]).toBe(FIRST_PAGE_ITEMS);
    });
  }

  it("leaves a request below the bound exactly as the caller made it", async () => {
    const postPaged = emptyPage();
    await byName["browse_folder"]!.handler(
      { bucketName: "cloudsee-demo", pageSize: 3 },
      { client: pagedClient(postPaged) },
    );
    expect(outboundBody(postPaged).pageSize).toBe(3);
  });
});

// CSD-667. The page size a later call sends is measured from the previous page and travels in the
// cursor, so the value on the wire is no longer a constant. A measurement is evidence, not an
// authority: it may lower a page, it may raise one the caller left to the connector, and it may
// never overrule the caller's own request, the schema, or the one-item floor.
describe("the page size carried in a cursor is bounded before it reaches the wire", () => {
  /** A cursor as a previous call would have minted it, carrying a measured page size. */
  function cursorWithHint(hint: number): string {
    return withPageSizeHint(encodeCursor("nextPage", "last-key-of-the-previous-page"), hint) as string;
  }

  /** A cursor carrying a page size no honest measurement produces — a corrupted or forged one. */
  function cursorWithRawHint(hint: unknown): string {
    return Buffer.from(JSON.stringify({ d: "nextPage", v: "last-key", p: hint }), "utf8").toString("base64url");
  }

  it("uses the measured size when the caller left the page size to the connector", async () => {
    const postPaged = emptyPage();
    await byName["browse_folder"]!.handler(
      { bucketName: "cloudsee-demo", cursor: cursorWithHint(42) },
      { client: pagedClient(postPaged) },
    );
    expect(outboundBody(postPaged).pageSize).toBe(42);
  });

  it("never exceeds what the caller explicitly asked for", async () => {
    const postPaged = emptyPage();
    await byName["browse_folder"]!.handler(
      { bucketName: "cloudsee-demo", pageSize: 5, cursor: cursorWithHint(42) },
      { client: pagedClient(postPaged) },
    );
    expect(outboundBody(postPaged).pageSize).toBe(5);
  });

  it("still lowers a page below what the caller asked for — that is the point of measuring", async () => {
    const postPaged = emptyPage();
    await byName["browse_folder"]!.handler(
      { bucketName: "cloudsee-demo", pageSize: 200, cursor: cursorWithHint(2) },
      { client: pagedClient(postPaged) },
    );
    expect(outboundBody(postPaged).pageSize).toBe(2);
  });

  it("never exceeds the schema maximum, whatever the cursor claims", async () => {
    const postPaged = emptyPage();
    await byName["browse_folder"]!.handler(
      { bucketName: "cloudsee-demo", cursor: cursorWithRawHint(5_000) },
      { client: pagedClient(postPaged) },
    );
    expect(outboundBody(postPaged).pageSize).toBe(200);
  });

  it("ignores a hint that is not a page size at all, and falls back to the seed", async () => {
    for (const hint of [0, -5, 1.5, "20", null]) {
      const postPaged = emptyPage();
      await byName["browse_folder"]!.handler(
        { bucketName: "cloudsee-demo", cursor: cursorWithRawHint(hint) },
        { client: pagedClient(postPaged) },
      );
      expect(outboundBody(postPaged).pageSize, `hint ${JSON.stringify(hint)} was not rejected`).toBe(FIRST_PAGE_ITEMS);
    }
  });

  // Cursors minted by the build now in production carry no page size. They are live in open
  // conversations, and decoding one must be a fallback, never an error.
  it("falls back to the seed for a cursor minted before the hint existed", async () => {
    const postPaged = emptyPage();
    await byName["browse_folder"]!.handler(
      { bucketName: "cloudsee-demo", cursor: encodeCursor("nextPage", "a-cursor-from-the-current-build") },
      { client: pagedClient(postPaged) },
    );
    expect(outboundBody(postPaged).pageSize).toBe(FIRST_PAGE_ITEMS);
  });

  // recent_files compares `hasMore` against the size it SENT. Reading the adaptive value for the
  // request and the seed for the comparison ends the walk one page in, and nothing else catches it.
  it("recent_files measures hasMore against the adaptive limit it actually sent", async () => {
    const data = Array.from({ length: 42 }, (_, index) => ({ Name: `file-${index}.txt` }));
    const postPaged = vi.fn().mockResolvedValue({ data, nextCursor: encodeCursor("nextPage", "next-key") });
    const res = await byName["recent_files"]!.handler(
      { cursor: cursorWithHint(42) },
      { client: pagedClient(postPaged) },
    );
    const [, body] = postPaged.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.limit).toBe(42);
    expect(res.content[0]?.text, "a page that came back full must advertise the next one").toContain("cursor=");
  });
});
