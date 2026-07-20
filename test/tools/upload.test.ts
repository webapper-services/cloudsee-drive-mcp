import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stat } from "node:fs/promises";
import { allTools } from "../../src/tools/index";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// Wrap node:fs/promises so `stat` can be overridden per-test (to exercise the
// >MAX_PARTS guard without a multi-GB file); everything else is the real module.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const uploadTool = allTools.find((t) => t.name === "upload_file")!;

const MIB = 1024 * 1024;

function fakeClient(post: ReturnType<typeof vi.fn>): CloudSeeClient {
  return { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
}

/** Build a fetch Response carrying an S3-style quoted ETag header. */
function partResponse(etag: string | null, status = 200): Response {
  const headers = etag === null ? undefined : { etag };
  return new Response("", { status, headers });
}

describe("upload_file", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `cloudsee-upload-${process.pid}-${Math.floor(performance.now())}.txt`);
    writeFileSync(tmpFile, "hello world");
  });
  afterEach(() => {
    try {
      rmSync(tmpFile);
    } catch {
      /* already gone */
    }
    vi.unstubAllGlobals();
  });

  it("uploads bytes then finalizes with the SERVER-provided key", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://s3.example/put?sig=1", key: "folder/hello.txt" })
      .mockResolvedValueOnce({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await uploadTool.handler({ bucketName: "test-bucket", localPath: tmpFile, destinationFolder: "folder" }, { client: fakeClient(post) });

    expect(fetchMock).toHaveBeenCalledOnce();
    const completeCall = post.mock.calls[1] as [string, { objects: Array<{ key: string }> }];
    expect(completeCall[0]).toBe("/storage/upload/complete");
    expect(completeCall[1].objects[0].key).toBe("folder/hello.txt"); // server key, not a guess
    expect(res.content[0]?.text).toContain("Uploaded");
  });

  it("derives the key from dirPath+fileName when the server omits it (live /storage/upload/url contract)", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://s3.example/put" }) // URL only — the real endpoint returns no key
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    // "folder" without a trailing slash — normalization must still yield folder/<name>.
    await uploadTool.handler({ bucketName: "test-bucket", localPath: tmpFile, destinationFolder: "folder" }, { client: fakeClient(post) });

    const presignCall = post.mock.calls[0] as [string, { dirPath: string }];
    expect(presignCall[1].dirPath).toBe("folder/"); // normalized for the server's verbatim concat
    const completeCall = post.mock.calls[1] as [string, { objects: Array<{ key: string }> }];
    expect(completeCall[1].objects[0].key).toBe(`folder/${tmpFile.split(/[\\/]/).pop()}`);
  });

  it("derives a root-level key when the destination folder is empty", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://s3.example/put" })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    await uploadTool.handler({ bucketName: "test-bucket", localPath: tmpFile, destinationFolder: "" }, { client: fakeClient(post) });

    const completeCall = post.mock.calls[1] as [string, { objects: Array<{ key: string }> }];
    expect(completeCall[1].objects[0].key).toBe(tmpFile.split(/[\\/]/).pop());
  });

  it("reports an orphan-risk error if finalization fails after the byte upload", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://s3.example/put", key: "folder/hello.txt" })
      .mockRejectedValueOnce(new Error("complete exploded"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    await expect(
      uploadTool.handler({ bucketName: "test-bucket", localPath: tmpFile, destinationFolder: "folder" }, { client: fakeClient(post) }),
    ).rejects.toMatchObject({ code: "finalize_failed" });
  });

  it("rejects a missing local file before calling the API", async () => {
    const post = vi.fn();
    await expect(
      uploadTool.handler({ bucketName: "test-bucket", localPath: "/no/such/file.xyz", destinationFolder: "" }, { client: fakeClient(post) }),
    ).rejects.toMatchObject({ code: "file_not_found" });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("upload_file (multipart, >8 MiB)", () => {
  let bigFile: string;

  beforeEach(() => {
    // 9 MiB > the 8 MiB threshold → exactly 2 parts at an 8 MiB part size.
    bigFile = join(tmpdir(), `cloudsee-upload-mp-${process.pid}-${Math.floor(performance.now())}.bin`);
    writeFileSync(bigFile, Buffer.alloc(9 * MIB, 7));
  });
  afterEach(() => {
    try {
      rmSync(bigFile);
    } catch {
      /* already gone */
    }
    vi.unstubAllGlobals();
  });

  it("splits into parts, PUTs each, and finalizes with ordered ETag/PartNumber", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" })
      .mockResolvedValueOnce({ ok: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(partResponse('"etag-1"'))
      .mockResolvedValueOnce(partResponse('"etag-2"'));
    vi.stubGlobal("fetch", fetchMock);

    const res = await uploadTool.handler({ bucketName: "test-bucket", localPath: bigFile, destinationFolder: "folder" }, { client: fakeClient(post) });

    const presignCall = post.mock.calls[0] as [string, { parts: number }];
    expect(presignCall[0]).toBe("/storage/upload/multipart-urls");
    expect(presignCall[1].parts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit).method === "PUT")).toBe(true);

    const completeCall = post.mock.calls[1] as [string, { uploadId: string; parts: Array<{ ETag: string; PartNumber: number }> }];
    expect(completeCall[0]).toBe("/storage/upload/complete-parts");
    expect(completeCall[1].uploadId).toBe("UP1");
    expect(completeCall[1].parts).toEqual([
      { ETag: '"etag-1"', PartNumber: 1 },
      { ETag: '"etag-2"', PartNumber: 2 },
    ]);
    expect(res.content[0]?.text).toContain("2 parts");
  });

  it("aborts the upload (empty parts) when a part PUT fails", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" })
      .mockResolvedValueOnce({ ok: true }); // the abort call
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(partResponse('"etag-1"', 500)));

    await expect(
      uploadTool.handler({ bucketName: "test-bucket", localPath: bigFile, destinationFolder: "folder" }, { client: fakeClient(post) }),
    ).rejects.toMatchObject({ code: "part_upload_failed" });

    const abortCall = post.mock.calls[1] as [string, { parts: unknown[] }];
    expect(abortCall[0]).toBe("/storage/upload/complete-parts");
    expect(abortCall[1].parts).toEqual([]);
  });

  it("aborts when storage returns a part with no ETag", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(partResponse(null)));

    await expect(
      uploadTool.handler({ bucketName: "test-bucket", localPath: bigFile, destinationFolder: "folder" }, { client: fakeClient(post) }),
    ).rejects.toMatchObject({ code: "no_etag" });
    expect((post.mock.calls[1] as [string, { parts: unknown[] }])[1].parts).toEqual([]);
  });

  it("refuses a file that needs more than 10,000 parts, without calling the API", async () => {
    const post = vi.fn();
    // 10,001 parts at an 8 MiB part size — faked size, no giant file written.
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => true, size: 10_001 * 8 * MIB } as Awaited<ReturnType<typeof stat>>);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadTool.handler({ bucketName: "test-bucket", localPath: bigFile, destinationFolder: "folder" }, { client: fakeClient(post) }),
    ).rejects.toMatchObject({ code: "too_many_parts" });
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
