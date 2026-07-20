import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// create_folder / rename_file / move_file / delete_files re-grounded
// on the queue-based contract. RequestType, AsCopy, UserId, email and role are
// pinned/injected server-side and must never appear in a request body.

const byName = Object.fromEntries(allTools.map((t) => [t.name, t]));
const SERVER_CONTROLLED = ["RequestType", "AsCopy", "UserId", "email", "role"] as const;

function fakeClient(post: ReturnType<typeof vi.fn>): CloudSeeClient {
  return { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
}

function firstText(res: { content: Array<{ text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

function expectNoServerControlledFields(body: Record<string, unknown>): void {
  for (const field of SERVER_CONTROLLED) expect(body, `"${field}" is server-controlled`).not.toHaveProperty(field);
}

describe("create_folder", () => {
  it("sends `object` as a { name } descriptor, not a bare string", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    await byName["create_folder"]!.handler(
      { bucketName: "test-bucket", parentPath: "docs/", name: "reports" },
      { client: fakeClient(post) },
    );

    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/storage/folder/create");
    expect(body).toEqual({ bucketName: "test-bucket", dirPath: "docs/", object: { name: "reports" } });
  });
});

describe("rename_file", () => {
  const tool = byName["rename_file"]!;

  it("previews without mutating when confirm is absent", async () => {
    const post = vi.fn();
    const res = await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", newName: "b.txt", storageId: "os-1" },
      { client: fakeClient(post) },
    );
    expect(post).not.toHaveBeenCalled();
    expect(firstText(res as never)).toContain("Confirmation required");
    expect(firstText(res as never)).toContain("docs/a.txt");
  });

  it("queues a file rename with the derived payload and no server-controlled fields", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-1" });
    const res = await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", newName: "b.txt", storageId: "os-1", confirm: true },
      { client: fakeClient(post) },
    );

    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/storage/object/rename-request");
    expect(body).toEqual({
      bucketName: "test-bucket",
      BucketName: "test-bucket",
      ObjectKey: "docs/a.txt",
      IsFolder: false,
      StorageId: "os-1",
      _id: "os-1",
      ObjectName: "a.txt",
      NewObjectName: "b.txt",
      SourcePath: "docs/a.txt",
      DestinationPath: "docs/a.txt",
      DestinationBucket: "test-bucket",
    });
    expectNoServerControlledFields(body);
    expect(firstText(res as never)).toContain("req-1");
    expect(firstText(res as never)).toContain("queued");
  });

  it("derives the folder name from a trailing-slash key and keeps the slash in path fields", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-2" });
    await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/old-folder/", newName: "new-folder", isFolder: true, storageId: "os-2", confirm: true },
      { client: fakeClient(post) },
    );

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.ObjectName).toBe("old-folder"); // trailing slash stripped before basename
    expect(body.IsFolder).toBe(true);
    expect(body.ObjectKey).toBe("docs/old-folder/");
    expect(body.SourcePath).toBe("docs/old-folder/");
    expect(body.DestinationPath).toBe("docs/old-folder/");
  });

  it("rejects a missing storageId before calling the API", async () => {
    const post = vi.fn();
    await expect(
      tool.handler({ bucketName: "test-bucket", objectKey: "docs/a.txt", newName: "b.txt", confirm: true }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("move_file", () => {
  const tool = byName["move_file"]!;

  it("requires confirm for a move and previews without mutating", async () => {
    const post = vi.fn();
    const res = await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", storageId: "os-1" },
      { client: fakeClient(post) },
    );
    expect(post).not.toHaveBeenCalled();
    expect(firstText(res as never)).toContain("Confirmation required");
  });

  it("queues a move via /storage/object/move-request, defaulting DestinationBucket to the source bucket", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-3" });
    const res = await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", storageId: "os-1", confirm: true },
      { client: fakeClient(post) },
    );

    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/storage/object/move-request");
    expect(body).toEqual({
      bucketName: "test-bucket",
      BucketName: "test-bucket",
      ObjectKey: "docs/a.txt",
      IsFolder: false,
      StorageId: "os-1",
      _id: "os-1",
      ObjectName: "a.txt",
      SourcePath: "docs/a.txt",
      DestinationPath: "archive/",
      DestinationBucket: "test-bucket",
    });
    expectNoServerControlledFields(body);
    expect(firstText(res as never)).toContain("req-3");
  });

  it("queues a copy via /storage/object/copy-request without requiring confirm", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-4" });
    const res = await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", asCopy: true, storageId: "os-1" },
      { client: fakeClient(post) },
    );

    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/storage/object/copy-request");
    expectNoServerControlledFields(body);
    expect(firstText(res as never)).toContain("Copy");
    expect(firstText(res as never)).toContain("req-4");
  });

  it("sends an explicit destinationBucket override as DestinationBucket", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-5" });
    await tool.handler(
      { bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", destinationBucket: "other-bucket", storageId: "os-1", confirm: true },
      { client: fakeClient(post) },
    );
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.DestinationBucket).toBe("other-bucket");
    expect(body.bucketName).toBe("test-bucket");
  });

  it("rejects a missing storageId before calling the API", async () => {
    const post = vi.fn();
    await expect(
      tool.handler({ bucketName: "test-bucket", objectKey: "docs/a.txt", destinationPath: "archive/", confirm: true }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("delete_files", () => {
  const tool = byName["delete_files"]!;

  it("previews the keys without mutating when confirm is absent", async () => {
    const post = vi.fn();
    const res = await tool.handler(
      { bucketName: "test-bucket", objects: [{ key: "docs/a.txt", storageId: "os-1" }, { key: "docs/old/", isFolder: true, storageId: "os-2" }] },
      { client: fakeClient(post) },
    );
    expect(post).not.toHaveBeenCalled();
    const text = firstText(res as never);
    expect(text).toContain("Confirmation required");
    expect(text).toContain("docs/a.txt");
    expect(text).toContain("docs/old/");
  });

  it("posts one delete-request per object, sequentially, with the queue payload", async () => {
    const post = vi.fn().mockResolvedValueOnce({ RequestId: "req-a" }).mockResolvedValueOnce({ RequestId: "req-b" });
    const res = await tool.handler(
      {
        bucketName: "test-bucket",
        objects: [
          { key: "docs/a.txt", storageId: "os-1" },
          { key: "docs/old/", isFolder: true, storageId: "os-2" },
        ],
        confirm: true,
      },
      { client: fakeClient(post) },
    );

    expect(post).toHaveBeenCalledTimes(2);
    // SourcePath must equal the key — the delete processor reads SourcePath, not ObjectKey.
    expect(post.mock.calls[0]).toEqual([
      "/storage/objects/delete-request",
      {
        bucketName: "test-bucket",
        BucketName: "test-bucket",
        ObjectKey: "docs/a.txt",
        IsFolder: false,
        StorageId: "os-1",
        _id: "os-1",
        ObjectName: "a.txt",
        SourcePath: "docs/a.txt",
        DestinationPath: "docs/a.txt",
        DestinationBucket: "test-bucket",
      },
    ]);
    expect(post.mock.calls[1]).toEqual([
      "/storage/objects/delete-request",
      {
        bucketName: "test-bucket",
        BucketName: "test-bucket",
        ObjectKey: "docs/old/",
        IsFolder: true,
        StorageId: "os-2",
        _id: "os-2",
        ObjectName: "old", // trailing slash stripped before basename
        SourcePath: "docs/old/",
        DestinationPath: "docs/old/",
        DestinationBucket: "test-bucket",
      },
    ]);
    for (const call of post.mock.calls) expectNoServerControlledFields((call as [string, Record<string, unknown>])[1]);

    const text = firstText(res as never);
    expect(text).toContain("req-a");
    expect(text).toContain("req-b");
    expect(res.isError).toBeUndefined();
  });

  it("reports every object on partial failure — surviving RequestIds plus the per-object error", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ RequestId: "req-a" })
      .mockRejectedValueOnce(new Error("insufficient_scope"))
      .mockResolvedValueOnce({ RequestId: "req-c" });
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

    expect(post).toHaveBeenCalledTimes(3); // no fail-fast: objects after the failure are still queued
    const text = firstText(res as never);
    expect(text).toContain("req-a");
    expect(text).toContain("req-c");
    expect(text).toContain("docs/b.txt: FAILED — insufficient_scope");
    expect(text).toContain("2 of 3");
    expect(res.isError).toBe(true);
  });
});
