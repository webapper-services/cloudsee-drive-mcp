import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stat } from "node:fs/promises";
import { allTools, hostedTools } from "../../src/tools/index";
import { clearJobs, getJob, type UploadJob } from "../../src/uploads";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// `upload_file` is ONE tool name with two schemas, picked by transport:
//   stdio  → localPath (server and user share a machine)
//   hosted → content   (server can't read the caller's disk; the caller can't PUT to S3)
// Both share collision handling and content-type resolution, which these tests pin.

// Wrap node:fs/promises so `stat` can be overridden per-test (to exercise the size guard
// without writing a multi-GB file); everything else is the real module.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const uploadLocal = allTools.find((t) => t.name === "upload_file")!;
const uploadInline = hostedTools.find((t) => t.name === "upload_file")!;
const uploadStatus = allTools.find((t) => t.name === "upload_status")!;

/** Pull the background-upload id out of what upload_file returns for a large file. */
function jobIdOf(result: { content: Array<{ text: string }> }): string {
  const id = /\b(up_[a-f0-9]+)\b/.exec(result.content[0]!.text)?.[1];
  if (!id) throw new Error(`No upload id in result:\n${result.content[0]!.text}`);
  return id;
}

/**
 * A large upload returns immediately and finishes on its own, so a test must wait for it —
 * otherwise afterEach un-stubs `fetch` while workers are still running and they escape to the
 * real network against s3.example, which hangs the whole run.
 */
async function settle(id: string): Promise<UploadJob> {
  for (let i = 0; i < 400; i++) {
    const job = getJob(id);
    if (job && job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Upload ${id} never finished`);
}

const MIB = 1024 * 1024;

function fakeClient(post: ReturnType<typeof vi.fn>): CloudSeeClient {
  return { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
}
const ctx = (post: ReturnType<typeof vi.fn>): { client: CloudSeeClient } => ({ client: fakeClient(post) });

/** A `post` mock whose first call — the collision probe — reports "nothing there". */
function postWithFreeName(...rest: unknown[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockRejectedValueOnce(new Error("not found"));
  for (const value of rest) mock.mockResolvedValueOnce(value);
  return mock;
}

/** Build a fetch Response carrying an S3-style quoted ETag header. */
function partResponse(etag: string | null, status = 200): Response {
  return new Response("", { status, headers: etag === null ? undefined : { etag } });
}

describe("upload_file — transport split", () => {
  it("stdio takes a path; hosted takes contents", () => {
    expect(Object.keys(uploadLocal.inputSchema)).toContain("localPath");
    expect(Object.keys(uploadInline.inputSchema)).toContain("content");
  });

  // The hosted server's filesystem is the Lambda's. A path there is useless and is an
  // arbitrary-file-read vector, so no hosted tool may accept one.
  it("no hosted tool accepts a server-side path", () => {
    for (const tool of hostedTools) {
      expect(Object.keys(tool.inputSchema), `${tool.name} must not take localPath`).not.toContain("localPath");
    }
  });

  it("hosted exposes the same names as stdio, minus the background-upload reporter", () => {
    const stdioOnly = allTools.map((t) => t.name).filter((n) => !hostedTools.some((h) => h.name === n));
    expect(stdioOnly).toEqual(["upload_status"]);
  });

  it("neither set contains a duplicate name", () => {
    for (const set of [allTools, hostedTools]) {
      expect(new Set(set.map((t) => t.name)).size).toBe(set.length);
    }
  });
});

describe("upload_file (stdio, localPath)", () => {
  let dir: string;
  let tmpFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cloudsee-up-"));
    tmpFile = join(dir, "hello.txt");
    writeFileSync(tmpFile, "hello world");
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    vi.unstubAllGlobals();
  });

  it("derives the content type from the file name, for the presign AND the PUT", async () => {
    const post = postWithFreeName({ url: "https://s3.example/put", key: "hello.txt" }, { ok: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadLocal.handler({ bucketName: "b", localPath: tmpFile }, ctx(post));

    // Storage re-derives the type from the name and signs with it; a mismatch here is a
    // 403 SignatureDoesNotMatch at PUT time.
    expect((post.mock.calls[1] as [string, { contentType: string }])[1].contentType).toBe("text/plain");
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
  });

  it("finalizes with the SERVER-provided key when one comes back", async () => {
    const post = postWithFreeName({ url: "https://s3.example/put", key: "folder/hello.txt" }, { ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    const res = await uploadLocal.handler(
      { bucketName: "b", localPath: tmpFile, destinationFolder: "folder" },
      ctx(post),
    );

    const [path, body] = post.mock.calls[2] as [string, { objects: Array<{ key: string }> }];
    expect(path).toBe("/storage/upload/complete");
    expect(body.objects[0].key).toBe("folder/hello.txt");
    expect(res.content[0]?.text).toContain("Uploaded");
  });

  it("derives the key from dirPath+fileName when the server omits it (live contract)", async () => {
    const post = postWithFreeName("https://s3.example/put", { ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    // "folder" without a trailing slash — the server concatenates verbatim.
    await uploadLocal.handler({ bucketName: "b", localPath: tmpFile, destinationFolder: "folder" }, ctx(post));

    expect((post.mock.calls[1] as [string, { dirPath: string }])[1].dirPath).toBe("folder/");
    expect((post.mock.calls[2] as [string, { objects: Array<{ key: string }> }])[1].objects[0].key).toBe(
      "folder/hello.txt",
    );
  });

  it("defaults to the drive root when destinationFolder is omitted entirely", async () => {
    const post = postWithFreeName("https://s3.example/put", { ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    await uploadLocal.handler({ bucketName: "b", localPath: tmpFile }, ctx(post));

    expect((post.mock.calls[1] as [string, { dirPath: string }])[1].dirPath).toBe("");
    expect((post.mock.calls[2] as [string, { objects: Array<{ key: string }> }])[1].objects[0].key).toBe("hello.txt");
  });

  it("renames instead of overwriting when the name is taken", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ objectKey: "hello.txt", size: 5 }) // collision probe hits
      .mockResolvedValueOnce("https://s3.example/put")
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    const res = await uploadLocal.handler({ bucketName: "b", localPath: tmpFile }, ctx(post));

    const stored = (post.mock.calls[2] as [string, { objects: Array<{ fileName: string }> }])[1].objects[0].fileName;
    expect(stored).toMatch(/^hello \(\d{2}-\d{2}-\d{4} \d{2}:\d{2}\)\.txt$/);
    expect(res.content[0]?.text).toContain("was already taken");
  });

  it("reports an orphan-risk error if finalization fails after the bytes are up", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("not found")) // collision probe: name is free
      .mockResolvedValueOnce({ url: "https://s3.example/put", key: "hello.txt" })
      .mockRejectedValueOnce(new Error("complete exploded"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    await expect(uploadLocal.handler({ bucketName: "b", localPath: tmpFile }, ctx(post))).rejects.toMatchObject({
      code: "finalize_failed",
    });
  });

  it("points at the near match when a name differs only by an invisible character", async () => {
    // The real case: a macOS screen recording whose time separator is U+202F NARROW NO-BREAK
    // SPACE. It renders identically to a plain space, so "not found" alone is a dead end.
    const real = `Recording at 7.20.08${String.fromCharCode(0x202f)}PM.mov`;
    writeFileSync(join(dir, real), "x");
    const asked = join(dir, "Recording at 7.20.08 PM.mov"); // plain space — no such file
    const post = vi.fn();

    const err = await uploadLocal.handler({ bucketName: "b", localPath: asked }, ctx(post)).catch((e: Error) => e);

    expect(err).toMatchObject({ code: "file_not_found" });
    expect((err as Error).message).toContain("U+202F");
    expect((err as Error).message).toContain("Recording at 7.20.08");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a missing file before calling the API", async () => {
    const post = vi.fn();
    await expect(
      uploadLocal.handler({ bucketName: "b", localPath: join(dir, "nope.xyz") }, ctx(post)),
    ).rejects.toMatchObject({ code: "file_not_found" });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("upload_file (stdio, large -> background)", () => {
  let dir: string;
  let bigFile: string;

  beforeEach(() => {
    clearJobs();
    dir = mkdtempSync(join(tmpdir(), "cloudsee-mp-"));
    bigFile = join(dir, "big.bin");
    writeFileSync(bigFile, Buffer.alloc(20 * MIB, 7)); // 20 MiB => 2 parts at 16 MiB
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    vi.unstubAllGlobals();
  });

  // The point of the whole design: the call must not sit there while a large file uploads,
  // because the client abandons it after 60s and reports a timeout over a working upload.
  it("returns immediately with an id instead of waiting", async () => {
    const post = postWithFreeName(
      { urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" },
      { ok: true }, // complete-parts
      { ok: true }, // registration
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(partResponse('"e1"')).mockResolvedValueOnce(partResponse('"e2"')),
    );

    const res = await uploadLocal.handler({ bucketName: "b", localPath: bigFile }, ctx(post));

    expect(res.content[0]?.text).toContain("background");
    const id = jobIdOf(res);

    const job = await settle(id);
    expect(job.state).toBe("completed");
    expect(job.completedParts).toBe(2);
    expect(job.bytesUploaded).toBe(20 * MIB);
  });

  // Assembling the multipart upload is NOT the same as putting the file in the drive.
  // `complete-parts` only stitches the S3 object together; without the separate registration
  // call the bytes sit in the bucket with no index entry — the drive shows a folder size and no
  // file, and get_file_metadata returns null. Seen in production before this was fixed.
  it("registers the object after assembling it, not just complete-parts", async () => {
    const post = postWithFreeName(
      { urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" },
      { ok: true }, // complete-parts
      { ok: true }, // registration
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(partResponse('"e"')));

    const res = await uploadLocal.handler({ bucketName: "b", localPath: bigFile, destinationFolder: "clips" }, ctx(post));
    const job = await settle(jobIdOf(res));
    expect(job.state).toBe("completed");

    expect((post.mock.calls[2] as [string])[0]).toBe("/storage/upload/complete-parts");

    const [registerPath, registerBody] = post.mock.calls[3] as [string, { dirPath: string; objects: Array<Record<string, unknown>> }];
    expect(registerPath).toBe("/storage/upload/complete");
    expect(registerBody.dirPath).toBe("clips/");
    expect(registerBody.objects[0]).toEqual({
      fileName: "big.bin",
      key: "clips/big.bin",
      contentType: "application/octet-stream",
      size: 20 * MIB,
    });
  });

  it("fails the job — loudly — when the object is assembled but not registered", async () => {
    const post = postWithFreeName(
      { urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" },
      { ok: true }, // complete-parts succeeds
    );
    post.mockRejectedValueOnce(new Error("index write exploded")); // registration fails
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(partResponse('"e"')));

    const res = await uploadLocal.handler({ bucketName: "b", localPath: bigFile }, ctx(post));
    const job = await settle(jobIdOf(res));

    expect(job.state).toBe("failed");
    expect(job.error).toContain("will not appear in listings");
    // Nothing to abort once the parts are assembled — an abort here would be meaningless.
    const abortAttempts = post.mock.calls.filter(
      ([path, body]) => path === "/storage/upload/complete-parts" && Array.isArray((body as { parts?: unknown[] }).parts) && (body as { parts: unknown[] }).parts.length === 0,
    );
    expect(abortAttempts).toHaveLength(0);
  });

  it("uploads parts concurrently and finalizes them in ascending order", async () => {
    const post = postWithFreeName(
      { urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" },
      { ok: true },
    );
    // Answer part 1 slowly so part 2 finishes first: proves the pool is concurrent, and that
    // the finalize list is ordered by part number rather than by completion.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("p1")) {
        await new Promise((r) => setTimeout(r, 40));
        return partResponse('"etag-1"');
      }
      return partResponse('"etag-2"');
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await uploadLocal.handler({ bucketName: "b", localPath: bigFile }, ctx(post));
    await settle(jobIdOf(res));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [completePath, completeBody] = post.mock.calls[2] as [
      string,
      { uploadId: string; parts: Array<{ ETag: string; PartNumber: number }> },
    ];
    expect(completePath).toBe("/storage/upload/complete-parts");
    expect(completeBody.uploadId).toBe("UP1");
    expect(completeBody.parts).toEqual([
      { ETag: '"etag-1"', PartNumber: 1 },
      { ETag: '"etag-2"', PartNumber: 2 },
    ]);
  });

  it("marks the job failed and aborts the upload when a part PUT fails", async () => {
    const post = postWithFreeName(
      { urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" },
      { ok: true }, // the abort call
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(partResponse('"e"', 500)));

    const res = await uploadLocal.handler({ bucketName: "b", localPath: bigFile }, ctx(post));
    const job = await settle(jobIdOf(res));

    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/part .* failed/i);
    const [abortPath, abortBody] = post.mock.calls[2] as [string, { parts: unknown[] }];
    expect(abortPath).toBe("/storage/upload/complete-parts");
    expect(abortBody.parts).toEqual([]); // empty list is the documented abort
  });

  it("marks the job failed when storage returns a part with no ETag", async () => {
    const post = postWithFreeName(
      { urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" },
      { ok: true },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(partResponse(null)));

    const res = await uploadLocal.handler({ bucketName: "b", localPath: bigFile }, ctx(post));
    const job = await settle(jobIdOf(res));

    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/ETag/i);
  });

  it("refuses a file over the 10,000-part limit without touching the network", async () => {
    const post = vi.fn();
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => true, size: 10_001 * 16 * MIB } as Awaited<
      ReturnType<typeof stat>
    >);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadLocal.handler({ bucketName: "b", localPath: bigFile }, ctx(post))).rejects.toMatchObject({
      code: "too_many_parts",
    });
    expect(post).not.toHaveBeenCalled(); // not even the collision probe
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("upload_status", () => {
  beforeEach(() => clearJobs());
  afterEach(() => vi.unstubAllGlobals());

  it("says so plainly when nothing has been started", async () => {
    const res = await uploadStatus.handler({}, ctx(vi.fn()));
    expect(res.content[0]?.text).toContain("No background uploads");
  });

  it("reports completion for a real job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudsee-st-"));
    const file = join(dir, "clip.mp4");
    writeFileSync(file, Buffer.alloc(20 * MIB, 1));
    try {
      const post = postWithFreeName(
        { urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" },
        { ok: true }, // complete-parts
        { ok: true }, // registration
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(partResponse('"e"')));

      const started = await uploadLocal.handler({ bucketName: "b", localPath: file }, ctx(post));
      const id = jobIdOf(started);
      await settle(id);

      const res = await uploadStatus.handler({ uploadId: id }, ctx(vi.fn()));
      const text = res.content[0]!.text;
      expect(text).toContain("COMPLETED");
      expect(text).toContain("2/2 parts");
      expect(text).toContain("clip.mp4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explains that ids do not survive a restart", async () => {
    await expect(uploadStatus.handler({ uploadId: "up_doesnotexist" }, ctx(vi.fn()))).rejects.toMatchObject({
      code: "unknown_upload",
    });
  });

  it("makes no API call", async () => {
    const post = vi.fn();
    await uploadStatus.handler({}, ctx(post));
    expect(post).not.toHaveBeenCalled();
  });
});
describe("upload_file (hosted, inline content)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the bytes itself with the derived content type, then registers the file", async () => {
    const post = postWithFreeName("https://s3.example/put?sig=1", { ok: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await uploadInline.handler(
      { bucketName: "b", destinationFolder: "docs", fileName: "report.md", content: "# hello" },
      ctx(post),
    );

    expect((post.mock.calls[1] as [string, { contentType: string }])[1].contentType).toBe("text/markdown");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://s3.example/put?sig=1");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/markdown");

    const [completePath, completeBody] = post.mock.calls[2] as [string, { objects: Array<Record<string, unknown>> }];
    expect(completePath).toBe("/storage/upload/complete");
    expect(completeBody.objects[0]).toEqual({
      fileName: "report.md",
      key: "docs/report.md",
      contentType: "text/markdown",
      size: 7,
    });
    expect(res.content[0]?.text).toContain("Uploaded");
  });

  it("decodes base64 back to the original bytes", async () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG magic — not valid utf8
    const post = postWithFreeName("https://s3.example/put", { ok: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadInline.handler(
      { bucketName: "b", fileName: "logo.png", content: raw.toString("base64"), encoding: "base64" },
      ctx(post),
    );

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as Uint8Array;
    expect(Buffer.from(body).equals(raw)).toBe(true);
    expect((post.mock.calls[2] as [string, { objects: Array<{ size: number }> }])[1].objects[0].size).toBe(raw.length);
  });

  it("rejects malformed base64 rather than storing a corrupted file", async () => {
    const post = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadInline.handler(
        { bucketName: "b", fileName: "x.bin", content: "not base64!!", encoding: "base64" },
        ctx(post),
      ),
    ).rejects.toMatchObject({ code: "bad_base64" });
    expect(post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses content over the inline ceiling before touching the API", async () => {
    const post = vi.fn();
    await expect(
      uploadInline.handler({ bucketName: "b", fileName: "big.txt", content: "x".repeat(256 * 1024 + 1) }, ctx(post)),
    ).rejects.toMatchObject({ code: "content_too_large" });
    expect(post).not.toHaveBeenCalled();
  });

  // The ceiling is enforced from the string's own length, so an oversized base64 payload is
  // refused without ever allocating the decode buffer it describes.
  it("refuses oversized base64 without decoding it", async () => {
    const post = vi.fn();
    const decode = vi.spyOn(Buffer, "from");

    // 4 base64 characters per 3 bytes — one group past the ceiling.
    const oversized = "A".repeat((256 * 1024 / 3 + 1) * 4);
    await expect(
      uploadInline.handler({ bucketName: "b", fileName: "big.bin", content: oversized, encoding: "base64" }, ctx(post)),
    ).rejects.toMatchObject({ code: "content_too_large" });

    expect(decode).not.toHaveBeenCalledWith(expect.anything(), "base64");
    expect(post).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  // MIME-wrapped base64 arrives with a newline every 76 characters. Those newlines push the
  // string well past any character-count bound derived from the byte ceiling, which is why the
  // guard measures decoded bytes rather than capping the field's length.
  it("accepts base64 wrapped in newlines", async () => {
    const raw = Buffer.alloc(4096, 0xab);
    const wrapped = raw.toString("base64").replace(/(.{76})/g, "$1\n");
    const post = postWithFreeName("https://s3.example/put", { ok: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadInline.handler(
      { bucketName: "b", fileName: "blob.bin", content: wrapped, encoding: "base64" },
      ctx(post),
    );

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as Uint8Array;
    expect(Buffer.from(body).equals(raw)).toBe(true);
  });

  it("renames instead of overwriting, and says so", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ objectKey: "report.md" }) // collision probe hits
      .mockResolvedValueOnce("https://s3.example/put")
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    const res = await uploadInline.handler({ bucketName: "b", fileName: "report.md", content: "hi" }, ctx(post));

    const stored = (post.mock.calls[2] as [string, { objects: Array<{ fileName: string }> }])[1].objects[0].fileName;
    expect(stored).toMatch(/^report \(\d{2}-\d{2}-\d{4} \d{2}:\d{2}\)\.md$/);
    expect(res.content[0]?.text).toContain('renamed from "report.md"');
  });

  it("surfaces a failed PUT without pretending the file landed", async () => {
    const post = postWithFreeName("https://s3.example/put");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));

    await expect(
      uploadInline.handler({ bucketName: "b", fileName: "a.txt", content: "hi" }, ctx(post)),
    ).rejects.toMatchObject({ code: "upload_failed" });
  });

  it("warns that the bytes are already stored when registration fails", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce("https://s3.example/put")
      .mockRejectedValueOnce(new Error("complete exploded"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    await expect(
      uploadInline.handler({ bucketName: "b", fileName: "a.txt", content: "hi" }, ctx(post)),
    ).rejects.toMatchObject({ code: "finalize_failed" });
  });
});
