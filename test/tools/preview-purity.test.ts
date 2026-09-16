import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-668 WP-3c. The unconfirmed preview of `delete_files` and `update_metadata` is a pure
// function of the caller's own arguments: it validates nothing and contacts no server. That
// is today's behaviour and this pass deliberately does not change it — these tests turn it
// from an accident into a documented property, so a later change that quietly adds a lookup
// (and with it a round trip, a latency cost and a second failure mode on a preview) is caught.
//
// It matters most for `update_metadata`, whose preview echoes an opaque 64-hex storage id no
// human can sanity-check; `delete_files` at least echoes readable object keys.

const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));

/** Any client call at all fails the test — stronger than asserting a call count of zero. */
function forbiddenClient(): { client: CloudSeeClient } {
  const refuse = (): never => {
    throw new Error("the confirmation preview must not contact the server");
  };
  return { client: { post: vi.fn(refuse), postPaged: vi.fn(refuse) } as unknown as CloudSeeClient };
}

function firstText(res: { content: Array<{ text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

const STORAGE_ID = "9fee3cc35397b5601e3525b48d8116e85367f70a81a74b03dd67789b884da9a4";

const PREVIEWS = [
  {
    tool: "delete_files",
    args: {
      bucketName: "test-bucket",
      objects: [
        { key: "docs/a.txt", storageId: "os-1" },
        { key: "docs/old/", isFolder: true, storageId: "os-2" },
      ],
    },
    echoed: ["docs/a.txt", "docs/old/"],
  },
  {
    tool: "update_metadata",
    args: { bucketName: "test-bucket", storageId: STORAGE_ID, metadata: { category: "video" } },
    echoed: [STORAGE_ID],
  },
] as const;

describe("confirmation previews are pure — no server call, no validation", () => {
  PREVIEWS.forEach(({ tool, args, echoed }) => {
    describe(tool, () => {
      it("renders without contacting the server", async () => {
        const res = await byName[tool]!.handler(args as unknown as Record<string, unknown>, forbiddenClient());
        expect(firstText(res as never)).toContain("Confirmation required");
      });

      it("echoes the caller's own arguments and nothing it could only have fetched", async () => {
        const text = firstText((await byName[tool]!.handler(args as unknown as Record<string, unknown>, forbiddenClient())) as never);
        for (const value of echoed) expect(text).toContain(value);
      });

      // No probe means no lookup to succeed or fail, so the same arguments must always
      // produce the same screen — including for an id that resolves to nothing.
      it("is deterministic: the same arguments render the same text every time", async () => {
        const first = firstText((await byName[tool]!.handler(args as unknown as Record<string, unknown>, forbiddenClient())) as never);
        const second = firstText((await byName[tool]!.handler(args as unknown as Record<string, unknown>, forbiddenClient())) as never);
        expect(second).toBe(first);
      });

      it("renders the same screen for an id or key that exists nowhere", async () => {
        const nonsense =
          tool === "delete_files"
            ? { bucketName: "test-bucket", objects: [{ key: "docs/a.txt", storageId: "does-not-exist" }] }
            : { bucketName: "test-bucket", storageId: "does-not-exist", metadata: { category: "video" } };
        const res = await byName[tool]!.handler(nonsense as Record<string, unknown>, forbiddenClient());
        expect(res.isError).toBeUndefined();
        expect(firstText(res as never)).toContain("Confirmation required");
      });
    });
  });
});
