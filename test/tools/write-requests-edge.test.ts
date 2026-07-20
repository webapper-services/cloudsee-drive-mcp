import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { allTools } from "../../src/tools/index";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// Adversarial probes for the queue-backed write tools:
// server-controlled-field exclusion, ObjectName derivation edges, delete
// aggregation boundaries, move/copy routing, and schema-level rejections.

const byName = Object.fromEntries(allTools.map((t) => [t.name, t]));
const SERVER_CONTROLLED = ["RequestType", "AsCopy", "UserId", "email", "role"] as const;

function fakeClient(post: ReturnType<typeof vi.fn>): CloudSeeClient {
  return { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
}

function firstText(res: { content: Array<{ text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

function expectNoServerControlledFields(body: Record<string, unknown>): void {
  for (const field of SERVER_CONTROLLED) expect(body, `"${field}" is server-controlled and must never be sent`).not.toHaveProperty(field);
}

/** Run rename_file with confirm=true and return the posted body. */
async function renameBody(objectKey: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const post = vi.fn().mockResolvedValue({ RequestId: "req-x" });
  await byName["rename_file"]!.handler(
    { bucketName: "test-bucket", objectKey, newName: "renamed", storageId: "os-1", confirm: true, ...extra },
    { client: fakeClient(post) },
  );
  return (post.mock.calls[0] as [string, Record<string, unknown>])[1];
}

describe("server-controlled fields are excluded from every outgoing body", () => {
  it("create_folder body carries none of RequestType/AsCopy/UserId/email/role", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    await byName["create_folder"]!.handler({ bucketName: "test-bucket", parentPath: "", name: "reports" }, { client: fakeClient(post) });
    expectNoServerControlledFields((post.mock.calls[0] as [string, Record<string, unknown>])[1]);
  });

  it("rename_file body carries none", async () => {
    expectNoServerControlledFields(await renameBody("docs/a.txt"));
  });

  it("move_file body carries none for a move and for a copy", async () => {
    for (const asCopy of [undefined, true]) {
      const post = vi.fn().mockResolvedValue({ RequestId: "req-x" });
      await byName["move_file"]!.handler(
        { bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", storageId: "os-1", asCopy, confirm: true },
        { client: fakeClient(post) },
      );
      expectNoServerControlledFields((post.mock.calls[0] as [string, Record<string, unknown>])[1]);
    }
  });

  it("delete_files body carries none for every queued object", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-x" });
    await byName["delete_files"]!.handler(
      { bucketName: "test-bucket", objects: [{ key: "a.txt", storageId: "os-1" }, { key: "b/", isFolder: true, storageId: "os-2" }], confirm: true },
      { client: fakeClient(post) },
    );
    for (const call of post.mock.calls) expectNoServerControlledFields((call as [string, Record<string, unknown>])[1]);
  });
});

describe("ObjectName derivation from the object key", () => {
  it("root-level file: 'file.txt' → 'file.txt'", async () => {
    expect((await renameBody("file.txt")).ObjectName).toBe("file.txt");
  });

  it("nested file: 'a/b/c.txt' → 'c.txt'", async () => {
    expect((await renameBody("a/b/c.txt")).ObjectName).toBe("c.txt");
  });

  it("folder at root: 'docs/' → 'docs'", async () => {
    expect((await renameBody("docs/", { isFolder: true })).ObjectName).toBe("docs");
  });

  it("nested folder: 'reports/2024/' → '2024', trailing slash preserved in Source/DestinationPath", async () => {
    const body = await renameBody("reports/2024/", { isFolder: true });
    expect(body.ObjectName).toBe("2024");
    expect(body.SourcePath).toBe("reports/2024/");
    expect(body.DestinationPath).toBe("reports/2024/");
    expect(body.ObjectKey).toBe("reports/2024/");
  });

  it("degenerate keys ('/', 'a//') yield an empty ObjectName — never produced by listings, rejected server-side", async () => {
    // Documented behavior, not a contract case: listing tools never return these
    // keys, and the queue handler owns validation of a nonsense ObjectName.
    expect((await renameBody("/")).ObjectName).toBe("");
    expect((await renameBody("a//")).ObjectName).toBe("");
  });
});

describe("delete_files aggregation boundaries", () => {
  const tool = byName["delete_files"]!;

  it("single success: one POST, RequestId reported, no isError", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-only" });
    const res = await tool.handler(
      { bucketName: "test-bucket", objects: [{ key: "docs/a.txt", storageId: "os-1" }], confirm: true },
      { client: fakeClient(post) },
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(firstText(res as never)).toContain("req-only");
    expect(res.isError).toBeUndefined();
  });

  it("all objects failing: every failure reported and isError set", async () => {
    const post = vi.fn().mockRejectedValue(new Error("insufficient_scope"));
    const res = await tool.handler(
      {
        bucketName: "test-bucket",
        objects: [
          { key: "docs/a.txt", storageId: "os-1" },
          { key: "docs/b.txt", storageId: "os-2" },
          { key: "docs/c.txt", storageId: "os-3" },
        ],
        confirm: true,
      },
      { client: fakeClient(post) },
    );
    expect(post).toHaveBeenCalledTimes(3);
    const text = firstText(res as never);
    expect(text).toContain("0 of 3");
    expect(text).toContain("docs/a.txt: FAILED — insufficient_scope");
    expect(text).toContain("docs/b.txt: FAILED — insufficient_scope");
    expect(text).toContain("docs/c.txt: FAILED — insufficient_scope");
    expect(res.isError).toBe(true);
  });

  it("posts sequentially — the second request starts only after the first resolves", async () => {
    const order: string[] = [];
    const post = vi.fn().mockImplementation(async (_path: string, body: Record<string, unknown>) => {
      order.push(`start:${body.ObjectKey}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${body.ObjectKey}`);
      return { RequestId: `req-${body.ObjectKey}` };
    });
    await tool.handler(
      { bucketName: "test-bucket", objects: [{ key: "a.txt", storageId: "os-1" }, { key: "b.txt", storageId: "os-2" }], confirm: true },
      { client: fakeClient(post) },
    );
    expect(order).toEqual(["start:a.txt", "end:a.txt", "start:b.txt", "end:b.txt"]);
  });

  it("rejects an object missing storageId at the schema, before any POST", async () => {
    const post = vi.fn();
    await expect(
      tool.handler({ bucketName: "test-bucket", objects: [{ key: "docs/a.txt" }], confirm: true }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an empty storageId (min length 1) before any POST", async () => {
    const post = vi.fn();
    await expect(
      tool.handler({ bucketName: "test-bucket", objects: [{ key: "docs/a.txt", storageId: "" }], confirm: true }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("move vs copy routing", () => {
  const tool = byName["move_file"]!;

  it("explicit asCopy=false routes to move-request and the confirm gate blocks without confirm", async () => {
    const post = vi.fn();
    const res = await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", asCopy: false, storageId: "os-1" },
      { client: fakeClient(post) },
    );
    expect(post).not.toHaveBeenCalled();
    expect(firstText(res as never)).toContain("Confirmation required");
  });

  it("explicit asCopy=false with confirm posts to move-request", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-m" });
    await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", asCopy: false, storageId: "os-1", confirm: true },
      { client: fakeClient(post) },
    );
    expect((post.mock.calls[0] as [string])[0]).toBe("/storage/object/move-request");
  });

  it("asCopy=true never sends AsCopy in the body — routing replaces the flag", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-c" });
    await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", asCopy: true, storageId: "os-1" },
      { client: fakeClient(post) },
    );
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/storage/object/copy-request");
    expect(body).not.toHaveProperty("AsCopy");
    expect(body).not.toHaveProperty("asCopy");
  });

  it("folder move derives ObjectName from the trailing-slash key", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-f" });
    await tool.handler(
      { bucketName: "test-bucket", objectKey: "reports/2024/", destinationPath: "archive/", isFolder: true, storageId: "os-1", confirm: true },
      { client: fakeClient(post) },
    );
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.ObjectName).toBe("2024");
    expect(body.SourcePath).toBe("reports/2024/");
    expect(body.DestinationPath).toBe("archive/");
  });
});

describe("schema-level guards", () => {
  it("rename_file schema rejects a missing or empty storageId", () => {
    const schema = z.object(byName["rename_file"]!.inputSchema);
    expect(schema.safeParse({ objectKey: "a.txt", newName: "b.txt" }).success).toBe(false);
    expect(schema.safeParse({ objectKey: "a.txt", newName: "b.txt", storageId: "" }).success).toBe(false);
    expect(schema.safeParse({ objectKey: "a.txt", newName: "b.txt", storageId: "os-1" }).success).toBe(true);
  });

  it("move_file schema rejects a missing storageId and an empty objectKey", () => {
    const schema = z.object(byName["move_file"]!.inputSchema);
    expect(schema.safeParse({ objectKey: "a.txt", destinationPath: "b/" }).success).toBe(false);
    expect(schema.safeParse({ objectKey: "", destinationPath: "b/", storageId: "os-1" }).success).toBe(false);
    expect(schema.safeParse({ objectKey: "a.txt", destinationPath: "b/", storageId: "os-1" }).success).toBe(true);
  });

  it("the four queue tools' storageId descriptions carry the indexed-listing warning", () => {
    for (const name of ["rename_file", "move_file"]) {
      const schema = byName[name]!.inputSchema as Record<string, z.ZodTypeAny>;
      expect(schema.storageId!.description, `${name}.storageId`).toContain("list_files");
      expect(schema.storageId!.description, `${name}.storageId`).toContain("search_files");
    }
    const deleteObjects = (byName["delete_files"]!.inputSchema as Record<string, z.ZodTypeAny>).objects as z.ZodArray<z.ZodObject<Record<string, z.ZodTypeAny>>>;
    const perObjectStorageId = deleteObjects.element.shape.storageId as z.ZodTypeAny;
    expect(perObjectStorageId.description).toContain("list_files");
  });
});
