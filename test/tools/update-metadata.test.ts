import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { allTools } from "../../src/tools/index";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

const tool = allTools.find((t) => t.name === "update_metadata")!;

function fakeClient(post: ReturnType<typeof vi.fn>): CloudSeeClient {
  return { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
}

function previewText(res: Awaited<ReturnType<typeof tool.handler>>): string {
  return (res.content?.[0] as { text: string }).text;
}

describe("update_metadata", () => {
  it("sends storageId (not objectKey) with metadata, tags and the mode, per the registry contract", async () => {
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
      mode: "merge",
      metadata: { category: "Finance", description: "Q3 budget" },
      tags: [{ Key: "team", Value: "finance" }],
    });
    expect(body).not.toHaveProperty("objectKey");
  });

  it("keeps an omitted metadata or tags argument OFF the wire — it is never coerced to {} or []", async () => {
    const post = vi.fn().mockResolvedValue(1);
    await tool.handler({ bucketName: "test-bucket", storageId: "os-doc-123", confirm: true }, { client: fakeClient(post) });

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("tags");
    expect(body).toEqual({ bucketName: "test-bucket", storageId: "os-doc-123", mode: "merge" });
  });

  it("sends tags: [] verbatim — an explicit clear-all must survive to the backend", async () => {
    const post = vi.fn().mockResolvedValue(1);
    await tool.handler(
      { bucketName: "test-bucket", storageId: "os-doc-123", tags: [], confirm: true },
      { client: fakeClient(post) },
    );

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.tags).toEqual([]);
  });

  it('sends metadata: { description: "" } verbatim — an empty string is the explicit clear', async () => {
    const post = vi.fn().mockResolvedValue(1);
    await tool.handler(
      { bucketName: "test-bucket", storageId: "os-doc-123", metadata: { description: "" }, confirm: true },
      { client: fakeClient(post) },
    );

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.metadata).toEqual({ description: "" });
  });

  it('forwards an explicit mode: "replace"', async () => {
    const post = vi.fn().mockResolvedValue(1);
    await tool.handler(
      { bucketName: "test-bucket", storageId: "os-doc-123", mode: "replace", confirm: true },
      { client: fakeClient(post) },
    );

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.mode).toBe("replace");
  });

  it("rejects a mode the endpoint does not implement", async () => {
    const post = vi.fn();
    await expect(
      tool.handler({ bucketName: "test-bucket", storageId: "os-doc-123", mode: "patch", confirm: true }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it("previews without mutating when confirm is absent, and says what merge keeps", async () => {
    const post = vi.fn();
    const res = await tool.handler(
      { bucketName: "test-bucket", storageId: "os-doc-123", metadata: { category: "X" } },
      { client: fakeClient(post) },
    );
    expect(post).not.toHaveBeenCalled();
    const text = previewText(res);
    expect(text).toContain("Confirmation required");
    expect(text).toContain("os-doc-123");
    expect(text).toContain("KEPT");
    expect(text).not.toContain("all cleared");
    expect(text).toContain("Tags: not sent — existing tags are kept");
  });

  it("previews the destructive wording for an explicit replace", async () => {
    const post = vi.fn();
    const res = await tool.handler(
      { bucketName: "test-bucket", storageId: "os-doc-123", mode: "replace", metadata: { category: "X" }, tags: [] },
      { client: fakeClient(post) },
    );
    expect(post).not.toHaveBeenCalled();
    const text = previewText(res);
    expect(text).toContain("replaced");
    expect(text).toContain("CLEARED");
  });

  it("warns in the preview that tags: [] clears every tag, even under merge", async () => {
    const post = vi.fn();
    const res = await tool.handler({ bucketName: "test-bucket", storageId: "os-doc-123", tags: [] }, { client: fakeClient(post) });
    expect(post).not.toHaveBeenCalled();
    expect(previewText(res)).toContain("CLEARS every tag");
  });

  it('names the fields a merge will clear, so an empty string is never a silent delete', async () => {
    const post = vi.fn();
    const res = await tool.handler(
      { bucketName: "test-bucket", storageId: "os-doc-123", metadata: { category: "X", description: "" } },
      { client: fakeClient(post) },
    );
    expect(post).not.toHaveBeenCalled();
    expect(previewText(res)).toContain("Fields that will be CLEARED (sent empty): description");
  });

  it("reports what the update did, from the outcome object the endpoint returns", async () => {
    const post = vi.fn().mockResolvedValue({
      updated: 1,
      mode: "merge",
      metadata: { changed: [], cleared: [], kept: ["category", "description", "project"] },
      tags: { set: ["Age"], removed: [], kept: ["Department", "Breed"], total: 3 },
    });
    const res = await tool.handler(
      { bucketName: "test-bucket", storageId: "os-doc-123", tags: [{ Key: "Age", Value: "Puppy" }], confirm: true },
      { client: fakeClient(post) },
    );

    const text = previewText(res);
    expect(text).toContain("mode: merge");
    expect(text).toContain("kept: category, description, project");
    expect(text).toContain("Tags — set: Age");
    expect(text).toContain("3 tag(s) now on the object");
  });

  it("falls back to the legacy text when the backend still answers with the bare update count", async () => {
    const post = vi.fn().mockResolvedValue(1);
    const res = await tool.handler({ bucketName: "test-bucket", storageId: "os-doc-123", confirm: true }, { client: fakeClient(post) });

    expect(previewText(res)).toBe('Updated metadata on storage id "os-doc-123".\n\n1');
  });

  it("rejects a missing storageId", async () => {
    const post = vi.fn();
    await expect(
      tool.handler({ bucketName: "test-bucket", metadata: { category: "X" }, confirm: true }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it("leaves an omitted metadata or tags key OUT of the parsed object — no .default(), .transform or .catch", () => {
    const parsed = z.object(tool.inputSchema).parse({ bucketName: "test-bucket", storageId: "os-doc-123", confirm: true });

    expect(Object.prototype.hasOwnProperty.call(parsed, "metadata")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "tags")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "mode")).toBe(false);
  });

  it('keeps an empty metadata field as "" through parsing — Zod must not coerce it away', () => {
    const parsed = z
      .object(tool.inputSchema)
      .parse({ bucketName: "test-bucket", storageId: "os-doc-123", metadata: { description: "" }, confirm: true }) as {
      metadata: Record<string, unknown>;
    };

    expect(parsed.metadata).toEqual({ description: "" });
    expect(Object.prototype.hasOwnProperty.call(parsed.metadata, "category")).toBe(false);
  });

  it("serialises the wire body without the omitted keys, so the backend sees them as absent", async () => {
    const post = vi.fn().mockResolvedValue(1);
    await tool.handler({ bucketName: "test-bucket", storageId: "os-doc-123", confirm: true }, { client: fakeClient(post) });

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(body)).toBe('{"bucketName":"test-bucket","storageId":"os-doc-123","mode":"merge"}');
  });

  it("does not accept a padded or differently-cased mode — the tool pins the exact wire values", async () => {
    const post = vi.fn();
    await expect(
      tool.handler({ bucketName: "test-bucket", storageId: "os-doc-123", mode: " MERGE ", confirm: true }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
