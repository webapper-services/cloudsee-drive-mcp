import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-668 WP-3b (F-04 / W-31), option D. `/storage/objects/delete-request` enqueues a Delete
// without requiring the target to resolve, so the connector's bare "queued (RequestId: …)"
// read as confirmation: a model reported a file deleted that never existed, and the tool's own
// "verify by listing until the objects disappear" made the wrong answer look confirmed,
// because a key that never existed also never appears in a listing.
//
// The connector reports what the queue established and, when the server states it
// (`TargetResolved`, WP-3a), whether the queued row names anything the index can see.

const deleteFiles = allTools.find((tool) => tool.name === "delete_files")!;

function clientPosting(post: ReturnType<typeof vi.fn>): { client: CloudSeeClient } {
  return { client: { post, postPaged: vi.fn() } as unknown as CloudSeeClient };
}

function firstText(res: { content: Array<{ text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

async function deleteOne(response: unknown): Promise<{ text: string; isError: boolean | undefined }> {
  const post = vi.fn().mockResolvedValue(response);
  const res = await deleteFiles.handler(
    { bucketName: "test-bucket", objects: [{ key: "docs/a.txt", storageId: "os-1" }], confirm: true },
    clientPosting(post),
  );
  return { text: firstText(res as never), isError: res.isError as boolean | undefined };
}

describe("delete_files — the outcome states what the queue established", () => {
  it("says the queue accepted the request rather than presenting it as a completed delete", async () => {
    const { text } = await deleteOne({ RequestId: "req-a" });
    expect(text).toContain("the delete queue accepted this request");
    expect(text).toContain("req-a");
    expect(text).toContain("Acceptance means the request was queued, not that the object was deleted or that it exists.");
  });

  it("still names the queue and the count, so an accepted batch reads unambiguously", async () => {
    const { text } = await deleteOne({ RequestId: "req-a" });
    expect(text).toContain("The delete queue accepted 1 request(s).");
  });

  it("warns on the object line when the server could not resolve the target", async () => {
    const { text, isError } = await deleteOne({ RequestId: "req-a", TargetResolved: false });
    expect(text).toContain("docs/a.txt:");
    expect(text).toContain("WARNING: the server could not resolve this object, so the request may delete nothing");
    expect(text).toContain("1 request(s) name an object the server could not resolve");
    // Warn-only: the backend accepted the row, so the call did not fail.
    expect(isError).toBeUndefined();
  });

  it("confirms the target when the server resolved it", async () => {
    const { text } = await deleteOne({ RequestId: "req-a", TargetResolved: true });
    expect(text).toContain("target resolved");
    expect(text).not.toContain("WARNING");
    expect(text).not.toContain("could not resolve");
  });

  // A server that predates WP-3a says nothing about the target. Silence is a third state and
  // must not be rendered as "not found" — that would invent a warning on every delete.
  it.each([
    ["an absent field", { RequestId: "req-a" }],
    ["a non-boolean field", { RequestId: "req-a", TargetResolved: "false" }],
    ["a null field", { RequestId: "req-a", TargetResolved: null }],
    ["no response body at all", null],
  ])("says nothing about the target for %s", async (_label, response) => {
    const { text } = await deleteOne(response);
    expect(text).not.toContain("WARNING");
    expect(text).not.toContain("could not resolve");
    expect(text).not.toContain("target resolved");
  });

  it("reports each object separately in a mixed batch and counts only the unresolved ones", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ RequestId: "req-a", TargetResolved: true })
      .mockResolvedValueOnce({ RequestId: "req-b", TargetResolved: false })
      .mockResolvedValueOnce({ RequestId: "req-c", TargetResolved: false });
    const res = await deleteFiles.handler(
      {
        bucketName: "test-bucket",
        objects: [
          { key: "docs/a.txt", storageId: "os-1" },
          { key: "docs/b.txt", storageId: "os-2" },
          { key: "docs/c.txt", storageId: "os-3" },
        ],
        confirm: true,
      },
      clientPosting(post),
    );

    const text = firstText(res as never);
    expect(text).toContain("The delete queue accepted 3 request(s).");
    expect(text).toContain("2 request(s) name an object the server could not resolve");
    expect(text).toContain("docs/a.txt: queued — the delete queue accepted this request (RequestId: req-a); target resolved");
    expect(res.isError).toBeUndefined();
  });

  it("keeps a transport failure a failure, distinct from an unresolved target", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ RequestId: "req-a", TargetResolved: false })
      .mockRejectedValueOnce(new Error("insufficient_scope"));
    const res = await deleteFiles.handler(
      {
        bucketName: "test-bucket",
        objects: [
          { key: "docs/a.txt", storageId: "os-1" },
          { key: "docs/b.txt", storageId: "os-2" },
        ],
        confirm: true,
      },
      clientPosting(post),
    );

    const text = firstText(res as never);
    expect(text).toContain("The delete queue accepted 1 of 2 request(s); 1 FAILED.");
    expect(text).toContain("docs/b.txt: FAILED — insufficient_scope");
    expect(res.isError).toBe(true);
  });
});
