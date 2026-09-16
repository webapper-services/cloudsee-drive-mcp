import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { CloudSeeError } from "../errors";
import { confirmShape, confirmationPreview } from "../confirm";
import { formatMetadataUpdate, summarize } from "./format";
import { mimeForFileName } from "./mime";
import { createJob, finishJob, getJob, listJobs, recordPart, type UploadJob } from "../uploads";
import { bucketField, normalizeFolder, resolveBucket, textResult, type ToolContext, type ToolDef } from "./types";

// Appended to every write/delete tool: the public API's RBAC is live,
// so a denial is a scope problem on the caller's key, never a rollout gate.
const RBAC_NOTE =
  " (Write access is authorized server-side by the public API's RBAC — a denial means the API key lacks this tool's scope, not a tool failure.)";

const MULTIPART_THRESHOLD = 8 * 1024 * 1024; // above this the upload is split into parts
const PART_SIZE = 16 * 1024 * 1024; // matches the web uploader's chunk size; >= S3's 5 MiB minimum
const MAX_PARTS = 10_000; // S3's hard limit on parts per multipart upload

// Parts uploaded at once. Parallelism does NOT create bandwidth — on a saturated link this
// changes nothing — but it keeps a high-latency or high-bandwidth-delay-product link busy
// instead of idling between round trips. Kept low because each worker holds its own PART_SIZE
// buffer: 4 x 16 MiB is the memory ceiling. (The web uploader runs 25, but a browser streams
// Blobs rather than buffering them.)
const PART_CONCURRENCY = 4;

function pickUrl(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["url", "uploadUrl", "signedUrl", "preSignedUrl", "presignedUrl", "putUrl"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return undefined;
}

// Prefer a key echoed in the presign response when one exists. When absent —
// the live `/storage/upload/url` contract returns only the URL string — the key
// is derived exactly the way the server builds it at BOTH presign
// (StorageService.generateSignedUrlPutFile: `${dirPath}${fileName}`) and
// finalize (FileService.completeFileUpload only uses dirPath + o.fileName), so
// the derivation cannot drift from the bytes' actual S3 key.
function pickKey(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["key", "objectKey", "Key", "objectPath", "filePath"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
    }
    const fields = record["fields"];
    if (fields && typeof fields === "object") {
      const nested = (fields as Record<string, unknown>)["key"];
      if (typeof nested === "string" && nested) return nested;
    }
  }
  return undefined;
}

// ============================================================================
// upload_file — ONE tool name, two schemas, chosen by transport.
//
//   stdio  : `localPath`  — server and user share a machine, so the server reads the file
//   hosted : `content`    — the server has no access to the caller's disk, so the bytes
//                           travel in the tool call and the server does the PUT
//
// Only one of the two is ever registered (see tools/index.ts), so a caller sees exactly one
// `upload_file` whose schema says what it needs. Both share the helpers below, so collision
// handling and content-type resolution behave identically.
// ============================================================================

type UploadClient = ToolContext["client"];

/** "report.md" → "report (30-07-2026 14:05).md" — the web uploader's collision rule
 *  (StorageContext.uploadSingle), so an upload never silently overwrites. */
function withTimestampSuffix(fileName: string, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? `${fileName.slice(0, dot)} (${stamp})${fileName.slice(dot)}` : `${fileName} (${stamp})`;
}

/** Is the key already taken? A failed lookup counts as "free": /storage/object/detail errors
 *  for a missing object, and a read-scope denial must not block a write the caller may make. */
async function objectExists(client: UploadClient, bucketName: string, objectKey: string): Promise<boolean> {
  try {
    const data = await client.post("/storage/object/detail", { bucketName, objectKey });
    if (!data) return false;
    if (Array.isArray(data)) return data.length > 0;
    return typeof data === "object" ? Object.keys(data).length > 0 : Boolean(data);
  } catch {
    return false;
  }
}

/** Resolve the final stored name, renaming on collision, and the content type storage will
 *  sign the URL with. Shared so both variants agree. */
async function resolveTarget(
  client: UploadClient,
  bucketName: string,
  dirPath: string,
  requestedName: string,
): Promise<{ fileName: string; contentType: string; key: string; renamed: boolean }> {
  const taken = await objectExists(client, bucketName, `${dirPath}${requestedName}`);
  const fileName = taken ? withTimestampSuffix(requestedName, new Date()) : requestedName;
  // Storage IGNORES the content type we ask for, re-derives one from the file name and signs
  // the URL with THAT, returning only the URL. Send anything else and S3 answers
  // 403 SignatureDoesNotMatch. So derive the same value. See src/tools/mime.ts.
  return { fileName, contentType: mimeForFileName(fileName), key: `${dirPath}${fileName}`, renamed: taken };
}

/**
 * "Local file not found" is technically true but useless when the name differs by an invisible
 * character — a real case here was a macOS screen recording whose time separator is U+202F
 * NARROW NO-BREAK SPACE, not a plain space. List the folder and point at the near match.
 */
async function notFoundError(localPath: string): Promise<CloudSeeError> {
  const wanted = basename(localPath);
  let hint = "";
  try {
    const siblings = await readdir(dirname(localPath) || ".");
    // JS \s covers the Unicode space separators — U+00A0 and U+202F included, which is
    // exactly the class that makes two names look identical without matching.
    const norm = (s: string): string => s.replace(/\s+/g, " ").toLowerCase();
    const close = siblings.filter((s) => norm(s) === norm(wanted) || s.toLowerCase() === wanted.toLowerCase());
    if (close.length) {
      const detail = close
        .map((s) => {
          const odd = [...s]
            .filter((c) => c.codePointAt(0)! > 0x7e)
            .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
          return `  ${JSON.stringify(s)}${odd.length ? `  ← contains ${[...new Set(odd)].join(", ")}` : ""}`;
        })
        .join("\n");
      hint = `\n\nA file in that folder differs only by invisible/typographic characters — copy this name exactly:\n${detail}`;
    }
  } catch {
    /* the folder itself is unreadable; the plain message stands */
  }
  return new CloudSeeError(`Local file not found: ${localPath}${hint}`, { code: "file_not_found" });
}

// ---- upload_file (stdio) → POST /storage/upload/url then /storage/upload/complete ----
const uploadSchema = z.object({
  bucketName: bucketField,
  localPath: z.string().min(1).describe("Path to the file to upload, on the machine running this server. Copy the name exactly — invisible characters in a file name are a common cause of 'not found'."),
  destinationFolder: z.string().optional().describe("Destination folder/prefix in the drive. Omit or empty = drive root."),
  fileName: z.string().optional().describe("Name to store the file as. Defaults to the local file's name."),
  storageClass: z.string().optional().describe("Optional S3 storage class (e.g. STANDARD, INTELLIGENT_TIERING)."),
});
type UploadArgs = z.infer<typeof uploadSchema> & { destinationFolder: string };

// Single-file path: one pre-signed PUT then a finalize. Used for files up to
// MULTIPART_THRESHOLD. Returns the human-readable result text.
async function uploadSingle(
  client: UploadClient,
  bucketName: string,
  a: UploadArgs,
  fileName: string,
  contentType: string,
  size: number,
): Promise<string> {
  const bytes = await readFile(a.localPath);
  const presign = await client.post<Record<string, unknown>>("/storage/upload/url", {
    bucketName,
    dirPath: a.destinationFolder,
    fileName,
    contentType,
    storageClass: a.storageClass,
  });
  const uploadUrl = pickUrl(presign);
  if (!uploadUrl) throw new CloudSeeError("The API did not return a usable upload URL.", { code: "no_upload_url" });

  const key = pickKey(presign) ?? `${a.destinationFolder}${fileName}`;

  const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new CloudSeeError(`Upload to storage failed (HTTP ${put.status}).`, { status: put.status, code: "upload_failed" });

  let complete: unknown;
  try {
    complete = await client.post("/storage/upload/complete", {
      bucketName,
      dirPath: a.destinationFolder,
      objects: [{ fileName, key, contentType, size }],
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CloudSeeError(
      `Bytes were uploaded to storage but finalization failed: ${reason}. The object may exist without an index entry — retry the upload, or remove it via the CloudSee app.`,
      { code: "finalize_failed" },
    );
  }
  return `Uploaded "${fileName}" (${size} bytes) to "${a.destinationFolder || "/"}".\n\n${summarize(complete)}`;
}

// Multipart path for files larger than MULTIPART_THRESHOLD. The API returns a
// 0-indexed map of pre-signed part URLs + an uploadId (no object key — the key
// is rebuilt server-side from dirPath+fileName at complete-parts). We read the
// file one PART_SIZE chunk at a time (bounded memory), PUT each part and capture
// its ETag, then finalize. On any failure we abort the upload (complete-parts
// with an empty parts list, the server's documented abort path) so no orphaned
// parts linger, then re-throw the original error.
async function uploadMultipart(
  client: UploadClient,
  bucketName: string,
  a: UploadArgs,
  fileName: string,
  contentType: string,
  size: number,
  jobId?: string,
): Promise<string> {
  const numParts = Math.ceil(size / PART_SIZE);
  if (numParts > MAX_PARTS) {
    throw new CloudSeeError(
      `File needs ${numParts} parts, over the ${MAX_PARTS}-part limit. Use the CloudSee web app for very large files.`,
      { code: "too_many_parts" },
    );
  }

  const presign = await client.post<Record<string, unknown>>("/storage/upload/multipart-urls", {
    bucketName,
    dirPath: a.destinationFolder,
    fileName,
    contentType,
    parts: numParts,
    storageClass: a.storageClass,
  });
  const uploadId = typeof presign.uploadId === "string" ? presign.uploadId : undefined;
  const urls = presign.urls;
  if (!uploadId || !urls || typeof urls !== "object") {
    throw new CloudSeeError("The API did not return multipart upload URLs.", { code: "no_part_urls" });
  }
  const urlMap = urls as Record<string, unknown>;

  const fh = await open(a.localPath, "r");
  let assembled = false;
  try {
    // Indexed by part number - 1, so a concurrent pool can fill it out of order and the
    // finalize call still sends parts in the ascending order S3 requires.
    const parts: Array<{ ETag: string; PartNumber: number }> = new Array(numParts);

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(PART_CONCURRENCY, numParts) }, async () => {
      // One buffer per worker: sharing would let a finished read be overwritten while fetch
      // still holds a reference to it.
      const buffer = Buffer.allocUnsafe(PART_SIZE);
      for (;;) {
        const index = nextIndex++;
        if (index >= numParts) return;

        const partUrl = pickUrl(urlMap[index]);
        if (!partUrl) throw new CloudSeeError(`Missing upload URL for part ${index + 1}.`, { code: "no_part_urls" });

        const position = index * PART_SIZE;
        const length = Math.min(PART_SIZE, size - position);
        // Positional reads ignore the file cursor, so workers can read the same handle safely.
        const { bytesRead } = await fh.read(buffer, 0, length, position);
        const body = new Uint8Array(buffer.subarray(0, bytesRead));

        const put = await fetch(partUrl, { method: "PUT", headers: { "Content-Type": contentType }, body });
        if (!put.ok) {
          throw new CloudSeeError(`Upload of part ${index + 1} failed (HTTP ${put.status}).`, { status: put.status, code: "part_upload_failed" });
        }
        const etag = put.headers.get("etag");
        if (!etag) throw new CloudSeeError(`Storage did not return an ETag for part ${index + 1}; cannot finalize.`, { code: "no_etag" });
        parts[index] = { ETag: etag, PartNumber: index + 1 };
        if (jobId) recordPart(jobId, bytesRead);
      }
    });
    // A rejecting worker leaves the others running; awaiting all of them before rethrowing
    // keeps the abort below from racing an in-flight PUT.
    const settled = await Promise.allSettled(workers);
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;

    // TWO calls are required, and missing the second one is silent. `complete-parts` only
    // assembles the S3 multipart upload (StorageService.completeMultiUpload → s3Repo, nothing
    // else); the object then exists in the bucket but has no index entry, so the drive shows a
    // folder size with no file in it and get_file_metadata returns null. Registration is a
    // separate call — the web uploader makes it too, for single and multipart alike
    // (StorageContext.completeUploadProcess → completeUploadFile).
    await client.post("/storage/upload/complete-parts", {
      bucketName,
      dirPath: a.destinationFolder,
      fileName,
      uploadId,
      parts,
    });
    assembled = true;

    let registered: unknown;
    try {
      registered = await client.post("/storage/upload/complete", {
        bucketName,
        dirPath: a.destinationFolder,
        objects: [{ fileName, key: `${a.destinationFolder}${fileName}`, contentType, size }],
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CloudSeeError(
        `All ${numParts} parts uploaded and the object was assembled, but registering it in the drive failed: ${reason}. The file is in storage yet will not appear in listings — retry the upload, or remove it via the CloudSee app.`,
        { code: "finalize_failed" },
      );
    }
    return `Uploaded "${fileName}" (${size} bytes, ${numParts} parts) to "${a.destinationFolder || "/"}".\n\n${summarize(registered)}`;
  } catch (err) {
    // Best-effort abort: an empty parts list tells the server to abort the multipart upload.
    // Skipped once the parts are assembled — there is no longer an in-flight upload to abort,
    // and the object that now exists is not something an abort would clean up anyway.
    if (!assembled) {
      try {
        await client.post("/storage/upload/complete-parts", { bucketName, dirPath: a.destinationFolder, fileName, uploadId, parts: [] });
      } catch {
        /* abort is best-effort */
      }
    }
    throw err;
  } finally {
    await fh.close();
  }
}

const uploadFileLocal: ToolDef = {
  name: "upload_file",
  title: "Upload file",
  description:
    "Upload a file into a folder of a drive. The file is read from the machine running this server — which, over this connection, is your own machine — so pass its path. Requires the drive (bucketName). Files up to 8 MiB are sent in one piece; larger ones are split into parts automatically. If the name is already taken, a timestamped name is used instead, so an existing file is never overwritten." +
    RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/upload/url", scopes: ["drive:write"] },
  inputSchema: uploadSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const parsed = uploadSchema.parse(args);
    const bucketName = resolveBucket(parsed.bucketName, defaultBucket);
    const dirPath = normalizeFolder(parsed.destinationFolder ?? "");

    let info;
    try {
      info = await stat(parsed.localPath);
    } catch {
      throw await notFoundError(parsed.localPath);
    }
    if (!info.isFile()) throw new CloudSeeError(`Not a regular file: ${parsed.localPath}`, { code: "not_a_file" });

    // Reject an impossible size before any network call, so a doomed upload costs nothing.
    const partCount = Math.ceil(info.size / PART_SIZE);
    if (info.size > MULTIPART_THRESHOLD && partCount > MAX_PARTS) {
      throw new CloudSeeError(
        `File needs ${partCount} parts, over the ${MAX_PARTS}-part limit. Use the CloudSee web app for very large files.`,
        { code: "too_many_parts" },
      );
    }

    const requestedName = parsed.fileName ?? basename(parsed.localPath);
    const { fileName, contentType, key, renamed } = await resolveTarget(client, bucketName, dirPath, requestedName);
    const a: UploadArgs = { ...parsed, destinationFolder: dirPath };
    const note = renamed ? `\n\n(Stored as "${fileName}" — "${requestedName}" was already taken.)` : "";

    if (info.size <= MULTIPART_THRESHOLD) {
      const text = await uploadSingle(client, bucketName, a, fileName, contentType, info.size);
      return textResult(`${text}${note}`);
    }

    // Past this size the upload cannot be waited on: an MCP client abandons a tool call after
    // 60s and nothing the server sends reliably extends that, so a multi-hundred-megabyte
    // upload would always be reported as a timeout even while it was succeeding. Start it,
    // hand back a handle, and let `upload_status` report on it — the same shape rename/move/
    // delete already use.
    const totalParts = Math.ceil(info.size / PART_SIZE);
    const job = createJob({
      bucketName,
      fileName,
      key,
      sizeBytes: info.size,
      partSize: PART_SIZE,
      totalParts,
    });

    void uploadMultipart(client, bucketName, a, fileName, contentType, info.size, job.id).then(
      () => finishJob(job.id),
      (err: unknown) => finishJob(job.id, err instanceof Error ? err.message : String(err)),
    );

    return textResult(
      `Upload started in the background — this file is too large to finish inside a single tool call.\n\n` +
        `  id        ${job.id}\n` +
        `  file      ${fileName} (${formatBytes(info.size)}, ${contentType})\n` +
        `  into      ${bucketName}:${a.destinationFolder || "/"}\n` +
        `  parts     ${totalParts} x ${formatBytes(PART_SIZE)}, ${PART_CONCURRENCY} at a time\n\n` +
        `Check on it with upload_status (id "${job.id}"). The file appears in the drive only once ` +
        `it reports "completed" — do not report it as uploaded before then.${note}`,
    );
  },
};

// ---- upload_status → reads the in-process registry; makes no API call ----
const uploadStatusSchema = z.object({
  uploadId: z
    .string()
    .optional()
    .describe("The id returned by upload_file. Omit to list every upload this server has tracked, newest first."),
});

/** Human-readable size — the numbers here are for a person reading a progress line. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

function describeJob(job: UploadJob): string {
  const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
  const percent = job.sizeBytes > 0 ? Math.floor((job.bytesUploaded / job.sizeBytes) * 100) : 0;
  const lines = [
    `${job.id}  ${job.state.toUpperCase()}`,
    `  file     ${job.fileName} (${formatBytes(job.sizeBytes)}) -> ${job.bucketName}:${job.key}`,
    `  progress ${job.completedParts}/${job.totalParts} parts, ${formatBytes(job.bytesUploaded)} (${percent}%)`,
    `  elapsed  ${elapsed.toFixed(0)}s`,
  ];
  if (job.state === "running" && job.completedParts > 0) {
    const rate = job.bytesUploaded / Math.max(elapsed, 1);
    const remaining = (job.sizeBytes - job.bytesUploaded) / Math.max(rate, 1);
    lines.push(`  eta      ~${Math.ceil(remaining)}s at ${formatBytes(rate)}/s`);
  }
  if (job.error) lines.push(`  error    ${job.error}`);
  return lines.join("\n");
}

const uploadStatus: ToolDef = {
  name: "upload_status",
  title: "Check a background upload",
  description:
    "Report progress on an upload started by 'upload_file' that was too large to finish inside one tool call. Give it the id upload_file returned, or omit the id to list every tracked upload. States are running, completed and failed; a file is only in the drive once its upload reports completed. This reads progress held in this server process and makes no API call, so it is safe to poll." +
    RBAC_NOTE,
  // No endpoint of its own; declared against the presign path it reports on so the
  // contract-drift test still has something real to match.
  endpoint: { method: "POST", path: "/storage/upload/multipart-urls", scopes: ["drive:write"] },
  inputSchema: uploadStatusSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args) => {
    const a = uploadStatusSchema.parse(args);

    if (a.uploadId) {
      const job = getJob(a.uploadId);
      if (!job) {
        throw new CloudSeeError(
          `No upload with id "${a.uploadId}". Uploads are tracked in memory, so a restart of this server clears them; the id is only valid for this session.`,
          { code: "unknown_upload" },
        );
      }
      return textResult(describeJob(job));
    }

    const all = listJobs();
    if (all.length === 0) {
      return textResult("No background uploads have been started in this session.");
    }
    return textResult(all.map(describeJob).join("\n\n"));
  },
};

// ---- upload_file (hosted) → same three calls, but the bytes arrive in the tool call ----
// A hosted server cannot read the caller's disk, and a hosted MCP client is normally barred
// from reaching *.s3.amazonaws.com itself (verified against production 2026-07-30:
// "Host not in allowlist: <bucket>.s3.amazonaws.com"), so neither a path nor a pre-signed
// handoff works there. Carrying the bytes through the request is what is left.
//
// The ceiling is the caller's context budget, not the transport: base64 inflates 33% and
// tokenizes at ~3-4 chars/token, so ~256 KB is already ~90k tokens. Refuse beyond that rather
// than let a caller burn its whole context and fail anyway.
const MAX_INLINE_BYTES = 256 * 1024;

function assertInlineSize(byteLength: number): void {
  if (byteLength <= MAX_INLINE_BYTES) return;
  throw new CloudSeeError(
    `That file is ${byteLength} bytes; this tool accepts up to ${MAX_INLINE_BYTES} because the whole payload travels in the request. Upload larger files through the CloudSee web app.`,
    { code: "content_too_large" },
  );
}

/** Buffer.from silently DROPS invalid base64 characters, which would store a quietly
 *  corrupted file, so a base64 payload is verified by re-encoding it.
 *
 *  The size is checked from the string itself, before any decode buffer exists. Decoding
 *  first and measuring afterwards would let a caller make the server allocate megabytes it
 *  is about to reject anyway — and on the base64 path the verification re-encode allocates
 *  the payload a second time. A `.max()` on the Zod field would be the obvious guard but is
 *  the wrong one: the byte ceiling is not a character ceiling, and any bound tight enough to
 *  be meaningful would reject MIME-wrapped base64, whose newlines this function accepts by
 *  design. */
function decodeInlineContent(content: string, encoding: "utf8" | "base64"): Buffer {
  if (encoding === "utf8") {
    // Counts the utf8 bytes without materialising them.
    assertInlineSize(Buffer.byteLength(content, "utf8"));
    return Buffer.from(content, "utf8");
  }

  const cleaned = content.replace(/\s+/g, "");
  // Every 4 base64 characters carry 3 bytes; the padding is the only thing that shortens the
  // last group, so this is the exact decoded length for well-formed input and an upper bound
  // for anything else — which the re-encode check below rejects regardless.
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  assertInlineSize(Math.max(0, Math.floor(cleaned.length / 4) * 3 - padding));

  const decoded = Buffer.from(cleaned, "base64");
  const strip = (s: string): string => s.replace(/=+$/, "");
  if (strip(decoded.toString("base64")) !== strip(cleaned)) {
    throw new CloudSeeError(
      "`content` is not valid base64. Send standard base64 with encoding='base64', or plain text with encoding='utf8'.",
      { code: "bad_base64" },
    );
  }
  return decoded;
}

const uploadInlineSchema = z.object({
  bucketName: bucketField,
  destinationFolder: z.string().optional().describe("Destination folder/prefix in the drive. Omit or empty = drive root."),
  fileName: z.string().min(1).describe("Name to store the file as, WITH its extension — the extension sets the stored content type."),
  content: z
    .string()
    .min(1)
    .describe("The file's contents: plain text when encoding is 'utf8' (the default), or standard base64 when it is 'base64'."),
  encoding: z
    .enum(["utf8", "base64"])
    .optional()
    .describe("How 'content' is encoded. Use 'base64' for any binary file (images, PDFs, video, archives). Default 'utf8'."),
  storageClass: z.string().optional().describe("Optional S3 storage class (e.g. STANDARD, INTELLIGENT_TIERING)."),
});

const uploadFileInline: ToolDef = {
  name: "upload_file",
  title: "Upload file",
  description:
    "Upload a file into a folder of a drive by passing its contents — text as-is, or binary as base64. Requires the drive (bucketName). The whole file travels in this request, so it suits documents and other modest files; anything larger than a few hundred kilobytes should go through the CloudSee web app instead. If the name is already taken, a timestamped name is used, so an existing file is never overwritten." +
    RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/upload/url", scopes: ["drive:write"] },
  inputSchema: uploadInlineSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = uploadInlineSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const dirPath = normalizeFolder(a.destinationFolder ?? "");

    // Refuses an oversized payload before decoding it — see decodeInlineContent.
    const bytes = decodeInlineContent(a.content, a.encoding ?? "utf8");

    const { fileName, contentType, key, renamed } = await resolveTarget(client, bucketName, dirPath, a.fileName);

    const presign = await client.post<Record<string, unknown>>("/storage/upload/url", {
      bucketName,
      dirPath,
      fileName,
      contentType,
      storageClass: a.storageClass,
    });
    const uploadUrl = pickUrl(presign);
    if (!uploadUrl) throw new CloudSeeError("The API did not return a usable upload URL.", { code: "no_upload_url" });
    const objectKey = pickKey(presign) ?? key;

    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(bytes),
    });
    if (!put.ok) {
      throw new CloudSeeError(`Upload to storage failed (HTTP ${put.status}).`, { status: put.status, code: "upload_failed" });
    }

    let complete: unknown;
    try {
      complete = await client.post("/storage/upload/complete", {
        bucketName,
        dirPath,
        objects: [{ fileName, key: objectKey, contentType, size: bytes.byteLength }],
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CloudSeeError(
        `The bytes are in storage but registering the file failed: ${reason}. The object may exist without an index entry — retry the upload, or remove it via the CloudSee app.`,
        { code: "finalize_failed" },
      );
    }

    const note = renamed ? ` (renamed from "${a.fileName}" — that name was taken)` : "";
    return textResult(
      `Uploaded "${fileName}" (${bytes.byteLength} bytes, ${contentType}) to "${a.destinationFolder || "/"}"${note}.\n\n${summarize(complete)}`,
    );
  },
};

// ---- Shared pieces of the queue-backed `*-request` write endpoints ----
// rename/move/copy/delete are asynchronous: the POST enqueues the operation and
// returns the queue record's RequestId; the task manager completes it in the
// background (typically under 2 minutes). RequestType, AsCopy and UserId are
// pinned/injected server-side per endpoint and must NEVER be sent from here.

/** Zod field for the indexed storage id every queue endpoint requires. */
const storageIdField = z
  .string()
  .min(1)
  .describe(
    "Storage/index id of the object — the StorageId field returned by search_files, browse_folder, or get_file_metadata. NOTE: the ids from list_files and recent_files belong to a different id space and will NOT work here.",
  );

/** Body fields common to every queue-backed request. */
function queueRequestBase(bucketName: string, objectKey: string, isFolder: boolean, storageId: string): Record<string, unknown> {
  return {
    bucketName,
    BucketName: bucketName,
    ObjectKey: objectKey,
    IsFolder: isFolder,
    StorageId: storageId,
    _id: storageId,
  };
}

/** Object name from its key: the trailing slash is stripped first so a folder
 *  key ("a/b/") yields the folder name ("b"), then the last path segment. */
function objectNameFromKey(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

/** The queue RequestId from the enqueue response (`data.RequestId`). */
function pickRequestId(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>)["RequestId"];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** "(RequestId: …)" when the response carried one, empty otherwise. */
function requestIdSuffix(data: unknown): string {
  const requestId = pickRequestId(data);
  return requestId ? ` (RequestId: ${requestId})` : "";
}

/**
 * `TargetResolved` from a delete-request response (storage-api, CSD-668 WP-3a): did the
 * server find an indexed object behind the storage id it just queued a delete for?
 *
 * `undefined` is a third state, not a synonym for `false`: a server that predates the field
 * says nothing about the target, and rendering silence as "not found" would invent a warning.
 */
function pickTargetResolved(data: unknown): boolean | undefined {
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>)["TargetResolved"];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/**
 * What one accepted delete request actually establishes.
 *
 * The endpoint enqueues a Delete without requiring the target to resolve, so a bare "queued"
 * read as confirmation is how a model came to report a file deleted that never existed
 * (CSD-668 F-04). The outcome therefore states what was established — the queue took the row
 * — and, when the server says so, that the row names nothing it can see.
 */
function deleteOutcome(data: unknown): string {
  const accepted = `queued — the delete queue accepted this request${requestIdSuffix(data)}`;
  const resolved = pickTargetResolved(data);
  if (resolved === false) return `${accepted}; WARNING: the server could not resolve this object, so the request may delete nothing`;
  if (resolved === true) return `${accepted}; target resolved`;
  return accepted;
}

// ---- create_folder → POST /storage/folder/create (createFolder, drive:write) ----
const createFolderSchema = z.object({
  bucketName: bucketField,
  parentPath: z.string().describe("Parent folder/prefix in the drive. Empty = drive root."),
  name: z.string().min(1).describe("New folder name."),
});
const createFolder: ToolDef = {
  name: "create_folder",
  title: "Create folder",
  description: "Create a new folder at the given path in a drive. Requires the drive (bucketName)." + RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/folder/create", scopes: ["drive:write"] },
  inputSchema: createFolderSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = createFolderSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    // The endpoint consumes `object` as a folder descriptor, not a bare name.
    const data = await client.post("/storage/folder/create", { bucketName, dirPath: a.parentPath, object: { name: a.name } });
    return textResult(`Created folder "${a.name}" in "${a.parentPath || "/"}".\n\n${summarize(data)}`);
  },
};

// ---- rename_file → POST /storage/object/rename-request (storageRenameRequest, drive:write) — destructive, queued ----
const renameSchema = z.object({
  bucketName: bucketField,
  objectKey: z.string().min(1).describe("Exact object key of the file or folder as returned by a listing tool (folders keep their trailing slash)."),
  newName: z.string().min(1).describe("New name."),
  isFolder: z.boolean().optional().describe("Set true when renaming a folder."),
  storageId: storageIdField,
  ...confirmShape,
});
const renameFile: ToolDef = {
  name: "rename_file",
  title: "Rename file or folder",
  description:
    "Rename a file or folder in a drive, addressed by its exact object key plus its storage id (the StorageId field from search_files / browse_folder / get_file_metadata — not from list_files or recent_files, whose ids are a different id space and will NOT work). Queued: returns a RequestId and the rename completes in the background, typically under 2 minutes — verify by listing until the new name appears. Requires the drive (bucketName). Destructive (changes the object's key). Requires confirm=true." +
    RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/object/rename-request", scopes: ["drive:write"] },
  inputSchema: renameSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = renameSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    if (!a.confirm) {
      return confirmationPreview(`rename ${a.isFolder ? "folder" : "file"} to "${a.newName}"`, `Drive: ${bucketName}\nTarget: ${a.objectKey}`);
    }
    // The rename processor treats DestinationBucket as the S3 target bucket and
    // Source/DestinationPath both as the object's current key.
    const data = await client.post("/storage/object/rename-request", {
      ...queueRequestBase(bucketName, a.objectKey, a.isFolder ?? false, a.storageId),
      ObjectName: objectNameFromKey(a.objectKey),
      NewObjectName: a.newName,
      SourcePath: a.objectKey,
      DestinationPath: a.objectKey,
      DestinationBucket: bucketName,
    });
    return textResult(
      `Rename to "${a.newName}" queued${requestIdSuffix(data)}. It completes in the background, typically under 2 minutes — verify by listing until the new name appears.\n\n${summarize(data)}`,
    );
  },
};

// ---- move_file → POST /storage/object/move-request (storageMoveRequest, drive:write) — destructive unless asCopy, queued ----
// The operation type is fixed per endpoint server-side, so a copy posts to the
// sibling /storage/object/copy-request row (same scope) instead of sending AsCopy.
const moveSchema = z.object({
  bucketName: bucketField,
  objectKey: z.string().min(1).describe("Exact source object key as returned by a listing tool (folders keep their trailing slash)."),
  destinationPath: z.string().min(1).describe("Destination folder prefix."),
  asCopy: z.boolean().optional().describe("Copy instead of move (copy is non-destructive; the source is kept)."),
  isFolder: z.boolean().optional().describe("Set true for a folder."),
  destinationBucket: z.string().optional().describe("Target drive, if different from the source drive."),
  storageId: storageIdField,
  ...confirmShape,
});
const moveFile: ToolDef = {
  name: "move_file",
  title: "Move or copy file",
  description:
    "Move (or copy, with asCopy=true) a file or folder to a new location, addressed by its exact object key plus its storage id (the StorageId field from search_files / browse_folder / get_file_metadata — not from list_files or recent_files, whose ids are a different id space and will NOT work). Queued: returns a RequestId and the operation completes in the background, typically under 2 minutes — verify by listing until the object appears at the destination. Requires the source drive (bucketName). A move removes the source and is destructive, so it requires confirm=true; a copy does not." +
    RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/object/move-request", scopes: ["drive:write"] },
  inputSchema: moveSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = moveSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const isMove = !a.asCopy;
    if (isMove && !a.confirm) {
      return confirmationPreview(`move "${a.objectKey}" → "${a.destinationPath}"`, "This removes the source. Pass asCopy=true to copy instead.");
    }
    const data = await client.post(isMove ? "/storage/object/move-request" : "/storage/object/copy-request", {
      ...queueRequestBase(bucketName, a.objectKey, a.isFolder ?? false, a.storageId),
      ObjectName: objectNameFromKey(a.objectKey),
      SourcePath: a.objectKey,
      DestinationPath: a.destinationPath,
      DestinationBucket: a.destinationBucket ?? bucketName,
    });
    return textResult(
      `${isMove ? "Move" : "Copy"} of "${a.objectKey}" → "${a.destinationPath}" queued${requestIdSuffix(data)}. It completes in the background, typically under 2 minutes — verify by listing until the object appears at the destination.\n\n${summarize(data)}`,
    );
  },
};

// ---- duplicate_file → POST /storage/object/duplicate (duplicateFile, drive:write) ----
const duplicateSchema = z.object({
  bucketName: bucketField,
  objectKey: z.string().min(1).describe("Source object key to duplicate."),
  storageId: z.string().optional().describe("Optional storage/index id."),
});
const duplicateFile: ToolDef = {
  name: "duplicate_file",
  title: "Duplicate file",
  description: "Create a copy of a file in the same location. Requires the drive (bucketName)." + RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/object/duplicate", scopes: ["drive:write"] },
  inputSchema: duplicateSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = duplicateSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const data = await client.post("/storage/object/duplicate", { bucketName, objectKey: a.objectKey, storageId: a.storageId });
    return textResult(`Duplicated "${a.objectKey}".\n\n${summarize(data)}`);
  },
};

// ---- delete_files → POST /storage/objects/delete-request (storageDeleteRequest, drive:delete) — destructive, queued ----
// The endpoint takes ONE object per request, so the tool posts sequentially and
// reports every object's outcome — a failure on one never hides the others.
const deleteObjectSchema = z.object({
  key: z.string().min(1).describe("Exact object key as returned by a listing tool (folders keep their trailing slash)."),
  isFolder: z.boolean().optional().describe("Set true for a folder."),
  storageId: storageIdField,
});
const deleteSchema = z.object({
  bucketName: bucketField,
  objects: z.array(deleteObjectSchema).min(1).describe("Objects to permanently delete (one queued request per object)."),
  ...confirmShape,
});
const deleteFiles: ToolDef = {
  name: "delete_files",
  title: "Delete files",
  description:
    "Permanently delete one or more files/folders from a drive, each addressed by its exact object key plus its storage id (the StorageId field from search_files / browse_folder / get_file_metadata — not from list_files or recent_files, whose ids are a different id space and will NOT work). Queued: returns a RequestId per object and the deletes complete in the background, typically under 2 minutes — verify by listing until the objects disappear. Requires the drive (bucketName). Destructive and irreversible. Requires confirm=true." +
    RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/objects/delete-request", scopes: ["drive:delete"] },
  inputSchema: deleteSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = deleteSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    if (!a.confirm) {
      return confirmationPreview(
        `permanently delete ${a.objects.length} object(s) from "${bucketName}"`,
        a.objects.map((o) => `  - ${o.key}`).join("\n"),
      );
    }
    const outcomes: string[] = [];
    let failures = 0;
    let unresolved = 0;
    for (const object of a.objects) {
      try {
        // The file-delete processor reads SourcePath — not ObjectKey — so it must
        // carry the key; without it the queue record sits at "New" forever.
        const data = await client.post("/storage/objects/delete-request", {
          ...queueRequestBase(bucketName, object.key, object.isFolder ?? false, object.storageId),
          ObjectName: objectNameFromKey(object.key),
          SourcePath: object.key,
          DestinationPath: object.key,
          DestinationBucket: bucketName,
        });
        if (pickTargetResolved(data) === false) unresolved += 1;
        outcomes.push(`  - ${object.key}: ${deleteOutcome(data)}`);
      } catch (err) {
        failures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        outcomes.push(`  - ${object.key}: FAILED — ${reason}`);
      }
    }
    const headline =
      failures === 0
        ? `The delete queue accepted ${a.objects.length} request(s).`
        : `The delete queue accepted ${a.objects.length - failures} of ${a.objects.length} request(s); ${failures} FAILED.`;
    // A key that never existed also never appears in a listing, so "verify by listing" cannot
    // by itself distinguish a completed delete from a request against nothing (CSD-668 §2).
    const unresolvedNote =
      unresolved > 0
        ? ` ${unresolved} request(s) name an object the server could not resolve — check the object key and its storage id rather than reading a disappearance from a listing as proof.`
        : "";
    const result = textResult(
      `${headline} Acceptance means the request was queued, not that the object was deleted or that it exists. ` +
        `Deletes complete in the background, typically under 2 minutes — verify by listing until the objects disappear.${unresolvedNote}\n${outcomes.join("\n")}`,
    );
    if (failures > 0) result.isError = true;
    return result;
  },
};

// ---- update_metadata → POST /storage/object/metadata (storageUpdateObjectMetadata, drive:write) — destructive ----
// The endpoint resolves the object by its OpenSearch storage id (the object key
// is re-read server-side from the index) and `mode` decides what an omitted
// value means (CSD-664, StorageService.updateObjectInfo):
//   merge   — a metadata field you do not send is KEPT, a field sent as "" is
//             CLEARED, and tags are merged by Key (unmentioned Keys kept).
//   replace — every metadata field and every tag you do not send is CLEARED.
// The API defaults to `replace` for backward compatibility; this tool asks for
// `merge` on every call unless the caller says otherwise, because a model
// addresses this tool like a patch. Sending tags: [] clears every tag in BOTH
// modes, so the coercion of an omitted argument to {} / [] must never come back.
const updateMetaSchema = z.object({
  bucketName: bucketField,
  storageId: z
    .string()
    .min(1)
    .describe("Storage/index id of the object — the StorageId field returned by search_files, browse_folder, or get_file_metadata. NOTE: the ids from list_files and recent_files belong to a different id space and will NOT work here."),
  mode: z
    .enum(["merge", "replace"])
    .optional()
    .describe('merge (default): metadata keys you omit are KEPT, a key sent as "" is CLEARED, and tags are merged by Key — a tag with the same Key is overwritten, others are kept. replace: every metadata field and every tag you do not send is CLEARED. Use replace to remove a single tag (send the complete set you want to keep).'),
  metadata: z
    .object({
      category: z.string().optional().describe("Category label."),
      description: z.string().optional().describe("Free-text description."),
      project: z.string().optional().describe("Project label."),
    })
    .optional()
    .describe('Metadata fields to set. Under the default merge mode a field you leave out is KEPT and a field sent as "" is CLEARED; under replace every field you leave out is CLEARED.'),
  tags: z
    .array(z.object({ Key: z.string().min(1), Value: z.string().min(1) }))
    .optional()
    .describe("Tags to apply. Under the default merge mode they are merged by Key — a tag with the same Key is overwritten and tags with other Keys are kept; under replace they become the COMPLETE tag set. Sending [] CLEARS every tag in both modes, and leaving this out keeps the existing tags under merge (clears them under replace)."),
  ...confirmShape,
});

type MetadataArgs = z.infer<typeof updateMetaSchema>["metadata"];
type TagArgs = z.infer<typeof updateMetaSchema>["tags"];

/**
 * CSD-668 O4. The target of this call is 64 hex characters no human can sanity-check, and the
 * preview makes no server call — so the screen must not read as if the id had been verified.
 * It says what it is: an argument copied back, not an object that was found.
 */
const TARGET_NOT_LOOKED_UP =
  "Target: the storage id is copied from your request — it was NOT looked up, so this screen cannot tell you whether it exists or which object it names. Check it against the StorageId from search_files, browse_folder or get_file_metadata before confirming.";

/** The unconfirmed preview: what this call will do, in the caller's chosen mode. */
function metadataUpdatePreview(bucketName: string, mode: "merge" | "replace", metadata: MetadataArgs, tags: TagArgs): string {
  const sentFields = Object.keys(metadata ?? {});
  const target = `Drive: ${bucketName}\n${TARGET_NOT_LOOKED_UP}`;
  if (mode === "replace") {
    const fields = sentFields.length > 0 ? sentFields.join(", ") : "(none — all metadata fields will be cleared)";
    return (
      `${target}\nMode: replace — every metadata field and every tag you do not send is CLEARED.\n` +
      `Metadata fields set: ${fields}\nTags after update: ${tags?.length ?? 0} (existing tags are replaced)`
    );
  }
  const cleared = Object.entries(metadata ?? {})
    .filter(([, value]) => value === "")
    .map(([field]) => field);
  const tagLine =
    tags === undefined
      ? "Tags: not sent — existing tags are kept"
      : tags.length === 0
        ? "Tags: [] sent — this CLEARS every tag on the object"
        : `Tags: merged by Key — ${tags.length} sent, tags with other Keys are kept`;
  return (
    `${target}\nMode: merge — anything you do not send is KEPT.\n` +
    `Metadata fields sent: ${sentFields.length > 0 ? sentFields.join(", ") : "(none — no metadata field will change)"}\n` +
    `Fields that will be CLEARED (sent empty): ${cleared.length > 0 ? cleared.join(", ") : "(none)"}\n` +
    tagLine
  );
}

const updateMetadata: ToolDef = {
  name: "update_metadata",
  title: "Update file metadata",
  description:
    'Update a file\'s metadata (category / description / project) and tags in a drive, addressed by its storage id (the StorageId field from search_files / browse_folder / get_file_metadata — not from list_files or recent_files, whose ids are a different id space and will NOT work). Defaults to mode "merge": a metadata field you do not send is KEPT, a field sent as "" is CLEARED, and tags are merged by Key — a tag with the same Key is overwritten and tags with other Keys are kept. Destructive cases: sending tags: [] CLEARS every tag on the object, and mode "replace" clears every metadata field and every tag you do not send — that is also the only way to remove a single tag, by sending the complete set you want to keep. Requires the drive (bucketName) and confirm=true. Note: the update rewrites the object in place (S3 copy) — its ETag changes (and may change format) and LastModified is set to the update time; ETag-keyed caches and sync tools will see the object as new. Objects larger than 5 GiB are updated via multipart copy; objects larger than 8 GiB are rejected, because the rewrite cannot finish inside the API request timeout.' +
    RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/object/metadata", scopes: ["drive:write"] },
  inputSchema: updateMetaSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = updateMetaSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const mode = a.mode ?? "merge";
    if (!a.confirm) {
      return confirmationPreview(
        `${mode === "merge" ? "update" : "overwrite"} metadata on storage id "${a.storageId}"`,
        metadataUpdatePreview(bucketName, mode, a.metadata, a.tags),
      );
    }
    // An omitted argument must stay OFF the wire: {} is harmless under merge but
    // [] is a clear-all for tags, and under replace both wipe the object.
    const data = await client.post("/storage/object/metadata", {
      bucketName,
      storageId: a.storageId,
      mode,
      ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
      ...(a.tags !== undefined ? { tags: a.tags } : {}),
    });
    return textResult(formatMetadataUpdate(data, a.storageId));
  },
};

// ---- restore_archived_file → POST /storage/object/restore (restoreObject, drive:write) — Glacier un-archive ----
const restoreSchema = z.object({
  bucketName: bucketField,
  objectKey: z.string().min(1).describe("Object key of the archived (Glacier) object to restore."),
  days: z.number().int().min(1).optional().describe("How many days to keep the restored copy available."),
  retrievalTier: z.enum(["Expedited", "Standard", "Bulk"]).optional().describe("Glacier retrieval tier (default Standard)."),
  storageId: z.string().optional().describe("Optional storage/index id."),
  ...confirmShape,
});
const restoreArchivedFile: ToolDef = {
  name: "restore_archived_file",
  title: "Restore archived file",
  description:
    "Begin restoring an archived (S3 Glacier) object so it can be downloaded. Requires the drive (bucketName). This is Glacier un-archiving — NOT recovery of a deleted file — and may incur retrieval cost and take minutes to hours. Requires confirm=true." + RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/object/restore", scopes: ["drive:write"] },
  inputSchema: restoreSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = restoreSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    if (!a.confirm) {
      return confirmationPreview(
        `restore archived object "${a.objectKey}"`,
        `Drive: ${bucketName}\nTier: ${a.retrievalTier ?? "Standard"}${a.days ? `, ${a.days} day(s)` : ""}. May incur retrieval cost.`,
      );
    }
    const data = await client.post("/storage/object/restore", {
      bucketName,
      objectKey: a.objectKey,
      days: a.days,
      retrievalTier: a.retrievalTier,
      storageId: a.storageId,
    });
    return textResult(`Restore initiated for "${a.objectKey}".\n\n${summarize(data)}`);
  },
};

/** Everything except the transport-specific `upload_file` variant. */
const commonWriteTools: ToolDef[] = [
  createFolder,
  renameFile,
  moveFile,
  duplicateFile,
  deleteFiles,
  updateMetadata,
  restoreArchivedFile,
];

/** stdio: `upload_file` reads a path, and a large one runs in the background — hence
 *  `upload_status`, which has nothing to report on any other transport. */
export const writeTools: ToolDef[] = [uploadFileLocal, uploadStatus, ...commonWriteTools];

/** hosted: same tool name, but the bytes come in the call — the server has no access to
 *  the caller's disk, and a hosted client cannot reach S3 to do a pre-signed PUT itself. */
export const writeToolsHosted: ToolDef[] = [uploadFileInline, ...commonWriteTools];
