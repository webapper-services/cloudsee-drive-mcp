import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
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
});
