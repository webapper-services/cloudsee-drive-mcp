import { describe, it, expect, vi, afterEach } from "vitest";
import { allTools, hostedTools } from "../../src/tools/index";
import { summarize } from "../../src/tools/format";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-668 WP-4a (F-06). `/storage/object/detail` answers `success:true, data:null` for an
// object it cannot resolve — two frames inside storage-api swallow the miss — so
// `get_file_metadata` printed the four characters "null" with an ok status and no error,
// while `get_file_tags` on the SAME key answered the CSD-638 ceiling sentence because its
// endpoint throws and reaches the server's classifier. The two probes now agree.

/** Verbatim from storage-api's PublicApiErrorClassifier — the wording both probes must share. */
const OBJECT_NOT_AVAILABLE = "The specified object does not exist or is not available to your credential.";

const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));
const getFileMetadata = byName["get_file_metadata"]!;
const uploadInline = hostedTools.find((tool) => tool.name === "upload_file")!;

function clientReturning(value: unknown): { client: CloudSeeClient } {
  return { client: { post: vi.fn().mockResolvedValue(value), postPaged: vi.fn() } as unknown as CloudSeeClient };
}

function firstText(res: { content: Array<{ text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

const MISSING = { bucketName: "test-bucket", objectKey: "docs/missing.txt" };

describe("get_file_metadata — an object the server cannot resolve", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["an empty array", []],
  ])("answers the ceiling sentence as an error for %s", async (_label, payload) => {
    const res = await getFileMetadata.handler(MISSING, clientReturning(payload));
    expect(res.isError).toBe(true);
    expect(firstText(res as never)).toBe(OBJECT_NOT_AVAILABLE);
  });

  it("never renders the bare literal the defect reported", async () => {
    expect(firstText((await getFileMetadata.handler(MISSING, clientReturning(null))) as never)).not.toBe("null");
  });

  // The ceiling is deliberate (CSD-638 D4): the connector cannot tell absence from a read
  // denial, and wording that claimed it could would make the pair an existence oracle.
  it("does not claim the object is missing — absence and denial must answer alike", async () => {
    expect(firstText((await getFileMetadata.handler(MISSING, clientReturning(null))) as never)).not.toMatch(/not found/i);
  });

  it("leaves a resolved record rendered exactly as before, with no error flag", async () => {
    const record = { Key: "docs/a.txt", Size: 12, StorageId: "os-1" };
    const res = await getFileMetadata.handler({ bucketName: "test-bucket", objectKey: "docs/a.txt" }, clientReturning(record));
    expect(res.isError).toBeUndefined();
    expect(firstText(res as never)).toBe(summarize(record));
  });

  it("a record whose own fields are empty is still a record, not an absence", async () => {
    const res = await getFileMetadata.handler(MISSING, clientReturning({ Key: "", Size: 0 }));
    expect(res.isError).toBeUndefined();
  });
});

// CSD-663 recorded `/storage/object/detail` as "the existence probe the MCP uploader's
// overwrite protection depends on". `objectExists` already treats ANY unusable answer as
// "the name is free", so WP-4a's error result cannot reach it — the upload path calls the
// client directly and never goes through the tool handler. Pinned so a later change that
// routes the probe through `get_file_metadata` cannot silently start renaming every upload.
describe("upload collision probe — a miss stays free (objectExists, unchanged)", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function uploadedKeyWhenProbeAnswers(probe: () => Promise<unknown>): Promise<string> {
    const post = vi
      .fn()
      .mockImplementationOnce(probe)
      .mockResolvedValueOnce("https://s3.example/put?sig=1")
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    await uploadInline.handler(
      { bucketName: "b", destinationFolder: "docs", fileName: "report.md", content: "# hello" },
      { client: { post, postPaged: vi.fn() } as unknown as CloudSeeClient },
    );

    const [, body] = post.mock.calls[2] as [string, { objects: Array<{ key: string }> }];
    return body.objects[0]!.key;
  }

  it("a null detail payload leaves the requested name untouched", async () => {
    expect(await uploadedKeyWhenProbeAnswers(async () => null)).toBe("docs/report.md");
  });

  it("an empty detail payload leaves the requested name untouched", async () => {
    expect(await uploadedKeyWhenProbeAnswers(async () => ({}))).toBe("docs/report.md");
  });

  it("a thrown probe leaves the requested name untouched — a read denial must not block a write", async () => {
    expect(
      await uploadedKeyWhenProbeAnswers(async () => {
        throw new Error("insufficient_scope");
      }),
    ).toBe("docs/report.md");
  });

  it("a populated detail payload still renames, so the three cases above are not vacuous", async () => {
    expect(await uploadedKeyWhenProbeAnswers(async () => ({ objectKey: "docs/report.md", size: 7 }))).not.toBe("docs/report.md");
  });
});
