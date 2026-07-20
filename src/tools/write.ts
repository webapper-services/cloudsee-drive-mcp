import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { CloudSeeError } from "../errors";
import { confirmShape, confirmationPreview } from "../confirm";
import { summarize } from "./format";
import { bucketField, resolveBucket, textResult, type ToolContext, type ToolDef } from "./types";

// Appended to every write/delete tool: the public API's RBAC is live,
// so a denial is a scope problem on the caller's key, never a rollout gate.
const RBAC_NOTE =
  " (Write access is authorized server-side by the public API's RBAC — a denial means the API key lacks this tool's scope, not a tool failure.)";

const MULTIPART_THRESHOLD = 8 * 1024 * 1024; // files larger than this switch to multipart
const PART_SIZE = 8 * 1024 * 1024; // bytes per multipart part (>= S3's 5 MiB minimum)
const MAX_PARTS = 10_000; // S3's hard limit on parts per multipart upload

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

// ---- upload_file → POST /storage/upload/url then /storage/upload/complete (drive:write) ----
const uploadSchema = z.object({
  bucketName: bucketField,
  localPath: z.string().min(1).describe("Path to the local file to upload (absolute, or relative to the server's working directory)."),
  destinationFolder: z.string().describe("Destination folder/prefix in the drive. Empty = drive root."),
  fileName: z.string().optional().describe("Name to store the file as. Defaults to the local file's name."),
  contentType: z.string().optional().describe("MIME type. Defaults to application/octet-stream."),
  storageClass: z.string().optional().describe("Optional S3 storage class (e.g. STANDARD, INTELLIGENT_TIERING)."),
});
type UploadArgs = z.infer<typeof uploadSchema>;
type UploadClient = ToolContext["client"];

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
  try {
    const parts: Array<{ ETag: string; PartNumber: number }> = [];
    const buffer = Buffer.allocUnsafe(PART_SIZE);
    for (let index = 0; index < numParts; index++) {
      const partUrl = pickUrl(urlMap[index]);
      if (!partUrl) throw new CloudSeeError(`Missing upload URL for part ${index + 1}.`, { code: "no_part_urls" });

      const position = index * PART_SIZE;
      const length = Math.min(PART_SIZE, size - position);
      const { bytesRead } = await fh.read(buffer, 0, length, position);
      // Copy out of the reused buffer — the next iteration overwrites it while
      // fetch may still hold a reference otherwise.
      const body = new Uint8Array(buffer.subarray(0, bytesRead));

      const put = await fetch(partUrl, { method: "PUT", headers: { "Content-Type": contentType }, body });
      if (!put.ok) {
        throw new CloudSeeError(`Upload of part ${index + 1} failed (HTTP ${put.status}).`, { status: put.status, code: "part_upload_failed" });
      }
      const etag = put.headers.get("etag");
      if (!etag) throw new CloudSeeError(`Storage did not return an ETag for part ${index + 1}; cannot finalize.`, { code: "no_etag" });
      parts.push({ ETag: etag, PartNumber: index + 1 });
    }

    const complete = await client.post("/storage/upload/complete-parts", {
      bucketName,
      dirPath: a.destinationFolder,
      fileName,
      uploadId,
      parts,
    });
    return `Uploaded "${fileName}" (${size} bytes, ${numParts} parts) to "${a.destinationFolder || "/"}".\n\n${summarize(complete)}`;
  } catch (err) {
    // Best-effort abort: an empty parts list tells the server to abort the
    // multipart upload. Swallow its failure so the original cause surfaces.
    try {
      await client.post("/storage/upload/complete-parts", { bucketName, dirPath: a.destinationFolder, fileName, uploadId, parts: [] });
    } catch {
      /* abort is best-effort */
    }
    throw err;
  } finally {
    await fh.close();
  }
}

const uploadFile: ToolDef = {
  name: "upload_file",
  title: "Upload file",
  description:
    "Upload a local file to a folder in a drive. Requires the drive (bucketName). Reads the file from the local machine, requests pre-signed upload URL(s), uploads the bytes to storage, then finalizes the object. Files up to 8 MiB use a single upload; larger files are uploaded in parts automatically." + RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/upload/url", scopes: ["drive:write"] },
  inputSchema: uploadSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const parsed = uploadSchema.parse(args);
    // The server concatenates dirPath+fileName verbatim at presign and multipart
    // finalize (no slash inserted), so a folder without a trailing "/" would
    // produce a mangled key. Normalize once for every path below.
    const a: UploadArgs = {
      ...parsed,
      destinationFolder:
        parsed.destinationFolder && !parsed.destinationFolder.endsWith("/")
          ? `${parsed.destinationFolder}/`
          : parsed.destinationFolder,
    };
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const fileName = a.fileName ?? basename(a.localPath);
    const contentType = a.contentType ?? "application/octet-stream";

    let info;
    try {
      info = await stat(a.localPath);
    } catch {
      throw new CloudSeeError(`Local file not found: ${a.localPath}`, { code: "file_not_found" });
    }
    if (!info.isFile()) throw new CloudSeeError(`Not a regular file: ${a.localPath}`, { code: "not_a_file" });

    const text =
      info.size > MULTIPART_THRESHOLD
        ? await uploadMultipart(client, bucketName, a, fileName, contentType, info.size)
        : await uploadSingle(client, bucketName, a, fileName, contentType, info.size);
    return textResult(text);
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
    "Storage/index id of the object — the StorageId field returned by the INDEXED listing tools (search_files, browse_folder, recent_files). NOTE: list_files reads straight from storage and returns a different id that will NOT work here.",
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
    "Rename a file or folder in a drive, addressed by its exact object key plus its storage id (the StorageId field from search_files / browse_folder / recent_files — not from list_files). Queued: returns a RequestId and the rename completes in the background, typically under 2 minutes — verify by listing until the new name appears. Requires the drive (bucketName). Destructive (changes the object's key). Requires confirm=true." +
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
    "Move (or copy, with asCopy=true) a file or folder to a new location, addressed by its exact object key plus its storage id (the StorageId field from search_files / browse_folder / recent_files — not from list_files). Queued: returns a RequestId and the operation completes in the background, typically under 2 minutes — verify by listing until the object appears at the destination. Requires the source drive (bucketName). A move removes the source and is destructive, so it requires confirm=true; a copy does not." +
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
    "Permanently delete one or more files/folders from a drive, each addressed by its exact object key plus its storage id (the StorageId field from search_files / browse_folder / recent_files — not from list_files). Queued: returns a RequestId per object and the deletes complete in the background, typically under 2 minutes — verify by listing until the objects disappear. Requires the drive (bucketName). Destructive and irreversible. Requires confirm=true." +
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
        outcomes.push(`  - ${object.key}: queued${requestIdSuffix(data)}`);
      } catch (err) {
        failures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        outcomes.push(`  - ${object.key}: FAILED — ${reason}`);
      }
    }
    const headline =
      failures === 0
        ? `Queued ${a.objects.length} delete request(s).`
        : `Queued ${a.objects.length - failures} of ${a.objects.length} delete request(s); ${failures} FAILED.`;
    const result = textResult(
      `${headline} Deletes complete in the background, typically under 2 minutes — verify by listing until the objects disappear.\n${outcomes.join("\n")}`,
    );
    if (failures > 0) result.isError = true;
    return result;
  },
};

// ---- update_metadata → POST /storage/object/metadata (storageUpdateObjectMetadata, drive:write) — destructive ----
// The endpoint resolves the object by its OpenSearch storage id (the object key
// is re-read server-side from the index) and SETS the full metadata/tag state:
// metadata fields left out are cleared to "", and the tags array replaces every
// existing tag (StorageService.updateObjectInfo).
const updateMetaSchema = z.object({
  bucketName: bucketField,
  storageId: z
    .string()
    .min(1)
    .describe("Storage/index id of the object — the StorageId field returned by the INDEXED listing tools (search_files, browse_folder, recent_files). NOTE: list_files reads straight from storage and returns a different id that will NOT work here."),
  metadata: z
    .object({
      category: z.string().optional().describe("Category label."),
      description: z.string().optional().describe("Free-text description."),
      project: z.string().optional().describe("Project label."),
    })
    .optional()
    .describe("Metadata to set. Full overwrite: a field left out here is CLEARED on the object."),
  tags: z
    .array(z.object({ Key: z.string().min(1), Value: z.string().min(1) }))
    .optional()
    .describe("The COMPLETE desired tag set for the object. Existing tags are replaced; omitting this clears all tags."),
  ...confirmShape,
});
const updateMetadata: ToolDef = {
  name: "update_metadata",
  title: "Update file metadata",
  description:
    "Update a file's metadata (category / description / project) and tags in a drive, addressed by its storage id (the StorageId field from search_files / browse_folder / recent_files — not from list_files). Destructive: this SETS the full state — omitted metadata fields and omitted tags are cleared. Requires the drive (bucketName) and confirm=true." +
    RBAC_NOTE,
  endpoint: { method: "POST", path: "/storage/object/metadata", scopes: ["drive:write"] },
  inputSchema: updateMetaSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = updateMetaSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    if (!a.confirm) {
      const fields = Object.keys(a.metadata ?? {}).join(", ") || "(none — all cleared)";
      const tagCount = a.tags?.length ?? 0;
      return confirmationPreview(
        `overwrite metadata on storage id "${a.storageId}"`,
        `Drive: ${bucketName}\nMetadata fields set: ${fields}\nTags after update: ${tagCount} (existing tags are replaced)`,
      );
    }
    const data = await client.post("/storage/object/metadata", {
      bucketName,
      storageId: a.storageId,
      metadata: a.metadata ?? {},
      tags: a.tags ?? [],
    });
    return textResult(`Updated metadata on storage id "${a.storageId}".\n\n${summarize(data)}`);
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

export const writeTools: ToolDef[] = [
  uploadFile,
  createFolder,
  renameFile,
  moveFile,
  duplicateFile,
  deleteFiles,
  updateMetadata,
  restoreArchivedFile,
];
