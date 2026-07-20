import { describe, it, expect, vi } from "vitest";
import { allTools } from "../src/tools/index";
import type { CloudSeeClient } from "../src/client/CloudSeeClient";

function findTool(name: string) {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

describe("destructive tools require two-step confirmation", () => {
  it("delete_files previews and does NOT call the API without confirm", async () => {
    const post = vi.fn();
    const client = { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
    const tool = findTool("delete_files");
    const res = await tool.handler(
      { bucketName: "test-bucket", objects: [{ key: "a/b.txt", storageId: "os-1" }, { key: "a/c.txt", storageId: "os-2" }] },
      { client },
    );
    expect(post).not.toHaveBeenCalled();
    expect(res.content[0]?.text).toContain("Confirmation required");
    expect(res.content[0]?.text).toContain("a/b.txt");
  });

  it("delete_files calls the API only when confirm=true", async () => {
    const post = vi.fn().mockResolvedValue({ RequestId: "req-1" });
    const client = { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
    const tool = findTool("delete_files");
    const res = await tool.handler({ bucketName: "test-bucket", objects: [{ key: "a/b.txt", storageId: "os-1" }], confirm: true }, { client });
    // SourcePath must equal the key — the delete processor reads SourcePath, not ObjectKey.
    expect(post).toHaveBeenCalledWith("/storage/objects/delete-request", {
      bucketName: "test-bucket",
      BucketName: "test-bucket",
      ObjectKey: "a/b.txt",
      IsFolder: false,
      StorageId: "os-1",
      _id: "os-1",
      ObjectName: "b.txt",
      SourcePath: "a/b.txt",
      DestinationPath: "a/b.txt",
      DestinationBucket: "test-bucket",
    });
    expect(res.content[0]?.text).toContain("queued");
  });

  it("move with asCopy=true is non-destructive and runs without confirm", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    const client = { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
    const tool = findTool("move_file");
    await tool.handler({ bucketName: "test-bucket", objectKey: "a", destinationPath: "b", asCopy: true, storageId: "os-1" }, { client });
    expect(post).toHaveBeenCalledOnce();
  });

  it("a plain move requires confirmation", async () => {
    const post = vi.fn();
    const client = { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
    const tool = findTool("move_file");
    const res = await tool.handler({ bucketName: "test-bucket", objectKey: "a", destinationPath: "b", storageId: "os-1" }, { client });
    expect(post).not.toHaveBeenCalled();
    expect(res.content[0]?.text).toContain("Confirmation required");
  });

  it("every destructive tool exposes a confirm input", () => {
    for (const tool of allTools) {
      if (tool.annotations.destructiveHint) {
        expect(Object.keys(tool.inputSchema), `${tool.name} must expose confirm`).toContain("confirm");
      }
    }
  });
});
