import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { allTools, hostedTools } from "../../src/tools/index";
import { clearJobs, getJob } from "../../src/uploads";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";
import type { ToolResult } from "../../src/tools/types";

// CSD-586 Defect 4. `upload_file` printed the finalize response verbatim, and that response is an
// empty array — `FileService.completeFileUpload` builds `createdFiles` and never appends to it —
// so a successful upload answered with "[]", which reads as "nothing was created". Immediately
// after, indexing takes its own time and every listing tool honestly reports the file as absent,
// with nothing anywhere saying that is expected. The two together tell a caller the upload failed.

const uploadLocal = allTools.find((tool) => tool.name === "upload_file")!;
const uploadInline = hostedTools.find((tool) => tool.name === "upload_file")!;
const renameFile = allTools.find((tool) => tool.name === "rename_file")!;

/** What storage-api really answers on finalize, plus a value that appears nowhere else — so
 *  "the payload was not rendered" is decidable rather than inferred from the absence of "[]". */
const FINALIZE_PAYLOAD = { createdFiles: [], sentinel: "SENTINEL-FINALIZE-PAYLOAD-8c41" };
const BARE_EMPTY_ARRAY: unknown[] = [];

const MIB = 1024 * 1024;

function ctx(post: ReturnType<typeof vi.fn>): { client: CloudSeeClient } {
  return { client: { post, postPaged: vi.fn() } as unknown as CloudSeeClient };
}

/** A `post` mock whose first call — the collision probe — reports "nothing there". */
function postWithFreeName(...rest: unknown[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockRejectedValueOnce(new Error("not found"));
  for (const value of rest) mock.mockResolvedValueOnce(value);
  return mock;
}

function firstText(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

/**
 * The sentence must not quote a duration: the ~30s measured on one drive is not a contract, and a
 * number in the text is the one part a caller will act on. (rule #19)
 */
function expectNoQuotedDuration(text: string): void {
  expect(text).not.toMatch(/\d+\s*(seconds?|minutes?|hours?|secs?|mins?)\b/i);
}

/** Everything a caller is told about when the file becomes listable. */
function expectIndexingNotice(text: string): void {
  expect(text).toMatch(/indexing is asynchronous/i);
  for (const tool of ["browse_folder", "search_files", "list_files"]) expect(text).toContain(tool);
  expectNoQuotedDuration(text);
}

describe("Defect 4 — upload_file (stdio, single file)", () => {
  let dir: string;
  let smallFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "csd586-up-"));
    smallFile = join(dir, "hello.txt");
    writeFileSync(smallFile, "hello world");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function upload(finalizeAnswer: unknown): Promise<string> {
    const post = postWithFreeName({ url: "https://s3.example/put", key: "hello.txt" }, finalizeAnswer);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    return firstText(await uploadLocal.handler({ bucketName: "b", localPath: smallFile }, ctx(post)));
  }

  it("never prints the finalize payload the server sends back", async () => {
    const text = await upload(FINALIZE_PAYLOAD);
    expect(text).not.toContain(FINALIZE_PAYLOAD.sentinel);
    expect(text).not.toContain("createdFiles");
  });

  it("never renders the bare empty array the defect reported", async () => {
    expect(await upload(BARE_EMPTY_ARRAY)).not.toContain("[]");
  });

  it("confirms the bytes are stored and says the file is not listable yet", async () => {
    const text = await upload(BARE_EMPTY_ARRAY);
    expect(text).toContain('Uploaded "hello.txt"');
    expect(text).toMatch(/bytes are stored/i);
    expectIndexingNotice(text);
  });

  it("still says the name was changed when a collision renamed the file", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ objectKey: "hello.txt", size: 5 }) // collision probe hits
      .mockResolvedValueOnce("https://s3.example/put")
      .mockResolvedValueOnce(BARE_EMPTY_ARRAY);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    const text = firstText(await uploadLocal.handler({ bucketName: "b", localPath: smallFile }, ctx(post)));

    expect(text).toContain("was already taken");
    expectIndexingNotice(text);
    expect(text).not.toContain("[]");
  });
});

describe("Defect 4 — upload_file (hosted, inline content)", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function upload(finalizeAnswer: unknown): Promise<string> {
    const post = postWithFreeName("https://s3.example/put?sig=1", finalizeAnswer);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    const result = await uploadInline.handler(
      { bucketName: "b", destinationFolder: "docs", fileName: "report.md", content: "# hello" },
      ctx(post),
    );
    return firstText(result);
  }

  it("never prints the finalize payload the server sends back", async () => {
    const text = await upload(FINALIZE_PAYLOAD);
    expect(text).not.toContain(FINALIZE_PAYLOAD.sentinel);
    expect(text).not.toContain("createdFiles");
  });

  it("never renders the bare empty array the defect reported", async () => {
    expect(await upload(BARE_EMPTY_ARRAY)).not.toContain("[]");
  });

  it("confirms the bytes are stored and says the file is not listable yet", async () => {
    const text = await upload(BARE_EMPTY_ARRAY);
    expect(text).toContain('Uploaded "report.md"');
    expect(text).toMatch(/bytes are stored/i);
    expectIndexingNotice(text);
  });
});

describe("Defect 4 — upload_file (stdio, large file handed to the background)", () => {
  let dir: string;
  let bigFile: string;

  beforeEach(() => {
    clearJobs();
    dir = mkdtempSync(join(tmpdir(), "csd586-mp-"));
    bigFile = join(dir, "big.bin");
    writeFileSync(bigFile, Buffer.alloc(20 * MIB, 7)); // 20 MiB => 2 parts at 16 MiB
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  /** The job keeps running after the handler returns; let it finish before `fetch` is un-stubbed,
   *  or its workers escape to the real network. */
  async function settle(text: string): Promise<void> {
    const id = /\b(up_[a-f0-9]+)\b/.exec(text)?.[1];
    if (!id) throw new Error(`No upload id in:\n${text}`);
    for (let attempt = 0; attempt < 400; attempt++) {
      if (getJob(id)?.state !== "running") return;
      await new Promise((done) => setTimeout(done, 5));
    }
    throw new Error(`Upload ${id} never finished`);
  }

  it("tells the caller about the indexing delay in the same breath as the background handle", async () => {
    const post = postWithFreeName(
      { urls: { 0: "https://s3.example/p1", 1: "https://s3.example/p2" }, uploadId: "UP1" },
      { ok: true }, // complete-parts
      FINALIZE_PAYLOAD, // registration
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200, headers: { etag: '"e"' } })));

    const text = firstText(await uploadLocal.handler({ bucketName: "b", localPath: bigFile }, ctx(post)));
    await settle(text);

    expect(text).toContain("background");
    expectIndexingNotice(text);
    expect(text).not.toContain("[]");
    expect(text).not.toContain(FINALIZE_PAYLOAD.sentinel);
  });
});

// The multipart branch builds its own completion text, but `upload_file` discards that string —
// the background job is started with `void uploadMultipart(...).then(() => finishJob(id))`, and
// `UploadJob` has no field for it — so no caller can observe it and no behavioural test can reach
// it. Pinned at the source instead, which is honest about being a static check.
describe("Defect 4 — the finalize payload is rendered on no upload path at all", () => {
  const writeSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../src/tools/write.ts"),
    "utf8",
  );

  it("no upload branch summarizes the /storage/upload/complete response", () => {
    const renderedFinalizePayload = /return[^;]*summarize\((complete|registered)\)/;
    expect(writeSource).not.toMatch(renderedFinalizePayload);
  });

  it("the multipart branch carries the same indexing notice as the other two", () => {
    // `${numParts} parts)` occurs only in the multipart confirmation; `[^;]*` keeps the match
    // inside that one statement, so a notice further down the file cannot stand in for it.
    expect(writeSource).toMatch(/\$\{numParts\} parts\)[^;]*INDEX_DELAY_NOTE/);
  });
});

describe("Defect 4 — the tool descriptions a model reads before it calls", () => {
  it.each([
    { transport: "stdio", tool: uploadLocal },
    { transport: "hosted", tool: uploadInline },
  ])("upload_file ($transport) states that indexing is asynchronous", ({ tool }) => {
    expect(tool.description).toMatch(/indexing is asynchronous/i);
    for (const listing of ["browse_folder", "search_files", "list_files"]) {
      expect(tool.description).toContain(listing);
    }
    expectNoQuotedDuration(tool.description);
  });

  // The remaining edge Daniela measured: the rename completes in the background and the
  // StorageId is stale for that window — and StorageId is exactly what delete_files and
  // move_file require, so reusing it silently addresses the wrong record.
  it("rename_file warns that the StorageId goes stale while the rename is in flight", () => {
    expect(renameFile.description).toMatch(/storageid goes stale/i);
    expect(renameFile.description).toContain("delete_files");
    expect(renameFile.description).toContain("move_file");
    expect(renameFile.description).toMatch(/re-read it from a listing/i);
  });
});
