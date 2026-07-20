import { z } from "zod";
import { summarize, withCursor } from "./format";
import { bucketField, resolveBucket, textResult, type ToolDef } from "./types";

// ---- list_buckets → POST /storage/buckets (storageBucketList, drive:read) ----
const listBuckets: ToolDef = {
  name: "list_buckets",
  title: "List buckets",
  description:
    "List the storage buckets (Amazon S3 buckets) the authenticated CloudSee Drive account can access. Use this first to discover available buckets before browsing or searching.",
  endpoint: { method: "POST", path: "/storage/buckets", scopes: ["drive:read"] },
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_args, { client }) => {
    const data = await client.post("/storage/buckets", {});
    return textResult(summarize(data));
  },
};

// ---- browse_folder → POST /storage/list (storageList, drive:read) ----
const browseSchema = z.object({
  bucketName: bucketField,
  path: z.string().optional().describe("Folder path / prefix within the drive to list. Empty or omitted = the drive root."),
  sortOption: z.string().optional().describe("Sort key, e.g. 'name_asc', 'name_desc', 'date_desc'."),
  pageSize: z.number().int().min(1).max(200).optional().describe("Max items per page (1-200, default 50)."),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous call."),
});
const browseFolder: ToolDef = {
  name: "browse_folder",
  title: "Browse folder",
  description:
    "List the files and sub-folders inside a folder of a drive (the indexed view), with sorting and pagination. Requires the drive (bucketName). To filter by keyword use 'search_files'; for a complete, recursive file listing straight from storage use 'list_files'.",
  endpoint: { method: "POST", path: "/storage/list", scopes: ["drive:read"] },
  inputSchema: browseSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = browseSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const { data, nextCursor } = await client.postPaged(
      "/storage/list",
      { bucketName, dirPath: a.path ?? "", sortOption: a.sortOption, pageSize: a.pageSize ?? 50 },
      "nextPage",
      a.cursor,
    );
    return textResult(withCursor(summarize(data), nextCursor));
  },
};

// ---- search_files → POST /storage/list with searchingKeyword (drive:read) ----
const searchSchema = z.object({
  bucketName: bucketField,
  query: z.string().min(1).describe("Keyword to match against file and folder names."),
  path: z.string().optional().describe("Folder within the drive to search under. Empty = drive root."),
  pageSize: z.number().int().min(1).max(200).optional().describe("Max items per page (1-200, default 50)."),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous call."),
});
const searchFiles: ToolDef = {
  name: "search_files",
  title: "Search files",
  description:
    "Search for files and folders by name keyword within a drive (the indexed view). Requires the drive (bucketName). Returns matches with pagination.",
  endpoint: { method: "POST", path: "/storage/list", scopes: ["drive:read"] },
  inputSchema: searchSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = searchSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const { data, nextCursor } = await client.postPaged(
      "/storage/list",
      { bucketName, dirPath: a.path ?? "", searchingKeyword: a.query, pageSize: a.pageSize ?? 50 },
      "nextPage",
      a.cursor,
    );
    return textResult(withCursor(summarize(data), nextCursor));
  },
};

// ---- list_files → POST /storage/bucket/files (getAllFilesInTheBucket, drive:read) ----
const listFilesSchema = z.object({
  bucketName: bucketField,
  deep: z.boolean().optional().describe("Recurse into sub-folders (default true)."),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous call."),
});
const listFiles: ToolDef = {
  name: "list_files",
  title: "List files in a drive",
  description:
    "List the files in a drive straight from storage, recursively by default — the most reliable way to see what a drive actually contains. Requires the drive (bucketName). Returns names, sizes, storage classes and keys, with pagination.",
  endpoint: { method: "POST", path: "/storage/bucket/files", scopes: ["drive:read"] },
  inputSchema: listFilesSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = listFilesSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const { data, nextCursor } = await client.postPaged(
      "/storage/bucket/files",
      { bucketName, deepQuery: a.deep ?? true },
      "marker",
      a.cursor,
    );
    return textResult(withCursor(summarize(data), nextCursor));
  },
};

// ---- recent_files → POST /storage/recent (storageRecentFiles, drive:read) ----
const recentSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().describe("Max items (1-200, default 50)."),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous call."),
});
const recentFiles: ToolDef = {
  name: "recent_files",
  title: "Recent files",
  description: "List the account's most recently accessed or modified files, newest first, with pagination.",
  endpoint: { method: "POST", path: "/storage/recent", scopes: ["drive:read"] },
  inputSchema: recentSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client }) => {
    const a = recentSchema.parse(args);
    const limit = a.limit ?? 50;
    // /storage/recent paginates with `nextToken` (a composite key returned at the
    // envelope level), not `nextPage`. It echoes that token even when the list is
    // exhausted, so only advertise a next page when this page came back full.
    const { data, nextCursor } = await client.postPaged("/storage/recent", { limit }, "nextToken", a.cursor);
    const hasMore = Array.isArray(data) && data.length >= limit;
    return textResult(withCursor(summarize(data), hasMore ? nextCursor : undefined));
  },
};

// ---- get_file_metadata → POST /storage/object/detail (storageDetail, drive:read) ----
const metaSchema = z.object({
  bucketName: bucketField,
  objectKey: z.string().min(1).describe("Full object key (path) of the file within the drive."),
});
const getFileMetadata: ToolDef = {
  name: "get_file_metadata",
  title: "Get file metadata",
  description:
    "Get detailed metadata for a single file or object (size, type, timestamps, storage class, and other attributes) by its object key. Requires the drive (bucketName).",
  endpoint: { method: "POST", path: "/storage/object/detail", scopes: ["drive:read"] },
  inputSchema: metaSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = metaSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const data = await client.post("/storage/object/detail", { bucketName, objectKey: a.objectKey });
    return textResult(summarize(data));
  },
};

// ---- get_file_tags → POST /storage/object/tagging (getObjectTagging, drive:read) ----
const tagsSchema = z.object({
  bucketName: bucketField,
  objectKey: z.string().min(1).describe("Full object key (path) of the file within the drive."),
});
const getFileTags: ToolDef = {
  name: "get_file_tags",
  title: "Get file tags",
  description: "Get the S3 object tags (key/value pairs) attached to a file, by object key. Requires the drive (bucketName).",
  endpoint: { method: "POST", path: "/storage/object/tagging", scopes: ["drive:read"] },
  inputSchema: tagsSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = tagsSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const data = await client.post("/storage/object/tagging", { bucketName, objectKey: a.objectKey });
    return textResult(summarize(data));
  },
};

export const readTools: ToolDef[] = [
  listBuckets,
  browseFolder,
  searchFiles,
  listFiles,
  recentFiles,
  getFileMetadata,
  getFileTags,
];
