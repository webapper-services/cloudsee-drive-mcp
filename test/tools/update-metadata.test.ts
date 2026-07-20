import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

const tool = allTools.find((t) => t.name === "update_metadata")!;

function fakeClient(post: ReturnType<typeof vi.fn>): CloudSeeClient {
  return { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
}

describe("update_metadata", () => {
  it("sends storageId (not objectKey) with metadata and tags, per the registry contract", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    await tool.handler(
      {
        bucketName: "test-bucket",
        storageId: "os-doc-123",
        metadata: { category: "Finance", description: "Q3 budget" },
        tags: [{ Key: "team", Value: "finance" }],
        confirm: true,
      },
      { client: fakeClient(post) },
    );

    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/storage/object/metadata");
    expect(body).toEqual({
      bucketName: "test-bucket",
      storageId: "os-doc-123",
      metadata: { category: "Finance", description: "Q3 budget" },
      tags: [{ Key: "team", Value: "finance" }],
    });
    expect(body).not.toHaveProperty("objectKey");
  });

  it("previews without mutating when confirm is absent, and warns about the full overwrite", async () => {
    const post = vi.fn();
    const res = await tool.handler(
      { bucketName: "test-bucket", storageId: "os-doc-123", metadata: { category: "X" } },
      { client: fakeClient(post) },
    );
    expect(post).not.toHaveBeenCalled();
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("Confirmation required");
    expect(text).toContain("os-doc-123");
    expect(text).toContain("replaced");
  });

  it("rejects a missing storageId", async () => {
    const post = vi.fn();
    await expect(
      tool.handler({ bucketName: "test-bucket", metadata: { category: "X" }, confirm: true }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
