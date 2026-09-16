import { z } from "zod";
import { readPageSizeHint, withPageSizeHint } from "../client/pagination";
import { FIRST_PAGE_ITEMS, recommendedPageSize, summarize, summarizeListing, withCursor } from "./format";
import { bucketField, normalizeFolder, resolveBucket, textResult, type ToolDef } from "./types";

/** The largest page any listing tool exposes — the bound in every listing schema below, and the
 *  ceiling the adaptive size may never pass whatever the previous page measured. */
const MAX_PAGE_ITEMS = 200;

// A listing page is bounded by what the renderer can show without abbreviating, so a complete
// listing is a WALK, not a big page (CSD-667). Both facts belong in every listing tool's own
// description: the model decides how to page from the description, not from this file.
const PAGE_SIZE_HINT = `Max items per page (1-${MAX_PAGE_ITEMS}, default ${FIRST_PAGE_ITEMS}). The connector sizes each page to what it can render whole, starting at ${FIRST_PAGE_ITEMS} and adapting to the size of your items from the previous page; a larger value is reduced to what fits.`;
const WALK_HINT =
  "For a complete listing, keep calling with the returned cursor until no cursor comes back — a page may be short, or even empty, while more results remain.";

/**
 * How many items THIS call asks the server for (CSD-667).
 *
 * The first call of a walk carries no cursor, so there is nothing measured to go on and it uses
 * the `FIRST_PAGE_ITEMS` seed. Every later call uses the size the previous page measured on the
 * caller's own items, which is what makes the walk converge on a real drive rather than on the
 * one the seed was calibrated against.
 *
 * Three bounds, none of which the measurement may cross: never more than the caller explicitly
 * asked for, never more than the schema maximum, never less than one item. A caller that asks
 * for a specific page size has said something the connector cannot measure its way past.
 */
function resolvePageSize(requested: number | undefined, cursor: string | undefined): number {
  const ceiling = Math.min(requested ?? MAX_PAGE_ITEMS, MAX_PAGE_ITEMS);
  const measured = readPageSizeHint(cursor);
  const wanted = measured ?? Math.min(requested ?? FIRST_PAGE_ITEMS, FIRST_PAGE_ITEMS);
  return Math.max(1, Math.min(wanted, ceiling));
}

/**
 * The cursor a listing page hands back. Withheld unless the whole server page was rendered
 * (CSD-667 clause 2) — a cursor emitted over an unrendered item skips it for good — and
 * otherwise carrying the page size measured from the items this page just rendered.
 */
function forwardCursor(nextCursor: string | undefined, data: unknown, complete: boolean): string | undefined {
  if (!complete || !nextCursor) return undefined;
  return withPageSizeHint(nextCursor, recommendedPageSize(data));
}

// ---- list_buckets → POST /storage/drives (storageDriveList, drive:read) ----
const listBuckets: ToolDef = {
  name: "list_buckets",
  title: "List drives",
  description:
    "List the drives registered to the authenticated CloudSee Drive account that the caller is allowed to see. Use this first to discover available drives before browsing or searching; the `Name` of a drive is the `bucketName` the other tools expect.",
  endpoint: { method: "POST", path: "/storage/drives", scopes: ["drive:read"] },
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_args, { client }) => {
    const data = await client.post("/storage/drives", {});
    return textResult(summarize(data));
  },
};

// ---- browse_folder → POST /storage/list (storageList, drive:read) ----
const browseSchema = z.object({
  bucketName: bucketField,
  path: z.string().optional().describe("Folder path / prefix within the drive to list. Empty or omitted = the drive root."),
  sortOption: z.string().optional().describe("Sort key, e.g. 'name_asc', 'name_desc', 'date_desc'."),
  pageSize: z.number().int().min(1).max(MAX_PAGE_ITEMS).optional().describe(PAGE_SIZE_HINT),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous call."),
});
const browseFolder: ToolDef = {
  name: "browse_folder",
  title: "Browse folder",
  description:
    "List the files and sub-folders inside a folder of a drive (the indexed view), with sorting and pagination. Requires the drive (bucketName). To filter by keyword use 'search_files'; for a complete, recursive file listing straight from storage use 'list_files'. " +
    WALK_HINT,
  endpoint: { method: "POST", path: "/storage/list", scopes: ["drive:read"] },
  inputSchema: browseSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = browseSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const { data, nextCursor } = await client.postPaged(
      "/storage/list",
      {
        bucketName,
        dirPath: normalizeFolder(a.path ?? ""),
        sortOption: a.sortOption,
        pageSize: resolvePageSize(a.pageSize, a.cursor),
      },
      "nextPage",
      a.cursor,
    );
    const render = summarizeListing(data);
    return textResult(withCursor(render.text, forwardCursor(nextCursor, data, render.complete)));
  },
};

// ---- search_files → POST /storage/list with searchingKeyword (drive:read) ----
const searchSchema = z.object({
  bucketName: bucketField,
  query: z.string().min(1).describe("Keyword to match against file and folder names."),
  path: z.string().optional().describe("Folder within the drive to search under. Empty = drive root."),
  pageSize: z.number().int().min(1).max(MAX_PAGE_ITEMS).optional().describe(PAGE_SIZE_HINT),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous call."),
});
const searchFiles: ToolDef = {
  name: "search_files",
  title: "Search files",
  description:
    "Search for files and folders by name keyword within a drive (the indexed view). Requires the drive (bucketName). Returns matches with pagination. " +
    WALK_HINT,
  endpoint: { method: "POST", path: "/storage/list", scopes: ["drive:read"] },
  inputSchema: searchSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = searchSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const { data, nextCursor } = await client.postPaged(
      "/storage/list",
      {
        bucketName,
        dirPath: normalizeFolder(a.path ?? ""),
        searchingKeyword: a.query,
        pageSize: resolvePageSize(a.pageSize, a.cursor),
      },
      "nextPage",
      a.cursor,
    );
    const render = summarizeListing(data);
    return textResult(withCursor(render.text, forwardCursor(nextCursor, data, render.complete)));
  },
};

// ---- list_files → POST /storage/bucket/files (getAllFilesInTheBucket, drive:read) ----

/**
 * The drive answered with more objects than the page size it was sent, so it is not honouring
 * the field — a storage-api build that predates CSD-667, or a regression in its single-call
 * rule. The connector cannot page inside one storage page, so completeness is not available
 * here; what is available is the truth and a tool that still works. Deploy-order skew must not
 * turn into a crash or a lie (CSD-664 precedent, CSD-667 AD8).
 *
 * The cursor is withheld deliberately: forwarding the drive's own marker would skip every
 * object between the rendered slice and the end of that oversized page.
 */
function pageSizeSkewNotice(returned: number, requested: number): string {
  return (
    `⚠ This drive returned ${returned} objects for a requested page size of ${requested} — it did not honour ` +
    `the page size. This response covers at most the first ${requested} of them (see "shown" for how many were ` +
    `rendered); the rest cannot be reached through this tool, and no pagination cursor is offered because ` +
    `following it would skip them. Use browse_folder or search_files for a complete listing of this drive.`
  );
}

const listFilesSchema = z.object({
  bucketName: bucketField,
  deep: z.boolean().optional().describe("Recurse into sub-folders (default true)."),
  pageSize: z.number().int().min(1).max(MAX_PAGE_ITEMS).optional().describe(PAGE_SIZE_HINT),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous call."),
});
const listFiles: ToolDef = {
  name: "list_files",
  title: "List files in a drive",
  description:
    "List the files in a drive straight from storage, recursively by default — the most reliable way to see what a drive actually contains. Requires the drive (bucketName). Returns names, sizes, storage classes and keys, with pagination. The object id in each result is regenerated on every call and must never be used for rename_file, move_file, update_metadata, or delete_files — use search_files, browse_folder, or get_file_metadata for a stable StorageId instead (recent_files returns a different id space and will not work there either). " +
    WALK_HINT,
  endpoint: { method: "POST", path: "/storage/bucket/files", scopes: ["drive:read"] },
  inputSchema: listFilesSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = listFilesSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    // ONE variable: the value sent is the value the skew check below compares against. Comparing
    // the drive's answer with anything else reports a shortfall that did not happen, or misses one
    // that did — and with an adaptive size this value differs from call to call (CSD-667).
    const pageSize = resolvePageSize(a.pageSize, a.cursor);
    const { data, nextCursor } = await client.postPaged(
      "/storage/bucket/files",
      { bucketName, deepQuery: a.deep ?? true, pageSize },
      "marker",
      a.cursor,
    );
    if (Array.isArray(data) && data.length > pageSize) {
      const render = summarizeListing(data.slice(0, pageSize));
      return textResult(`${render.text}\n\n${pageSizeSkewNotice(data.length, pageSize)}`);
    }
    // Keep going on the presence of a cursor alone, never on a short or empty page: the
    // permission predicate, the skipped prefix and `*.FolderInfo` markers, and the server's
    // scan cap can all empty a page while a marker still points past it (CSD-667 C2).
    const render = summarizeListing(data);
    return textResult(withCursor(render.text, forwardCursor(nextCursor, data, render.complete)));
  },
};

// ---- recent_files → POST /storage/recent (storageRecentFiles, drive:read) ----
const recentSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_ITEMS)
    .optional()
    .describe(
      `Max items (1-${MAX_PAGE_ITEMS}, default ${FIRST_PAGE_ITEMS}). The connector sizes each page to what it can render whole, starting at ${FIRST_PAGE_ITEMS} and adapting to the size of your items from the previous page; a larger value is reduced to what fits.`,
    ),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous call."),
});
const recentFiles: ToolDef = {
  name: "recent_files",
  title: "Recent files",
  // Not WALK_HINT: a short page IS the end of this list (AD7), so promising otherwise here
  // would send the model back for a page that does not exist.
  description:
    "List the account's most recently accessed or modified files, newest first, with pagination. " +
    "For a complete listing, keep calling with the returned cursor until no cursor comes back.",
  endpoint: { method: "POST", path: "/storage/recent", scopes: ["drive:read"] },
  inputSchema: recentSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client }) => {
    const a = recentSchema.parse(args);
    // ONE variable, both sent and compared. Comparing the resolved request against the caller's
    // original `a.limit` makes `hasMore` permanently false and truncates the walk at page one —
    // and the resolved value now varies per call, so `hasMore` must be read against what THIS
    // call actually sent, never against the seed or the caller's ask (CSD-667 R2).
    const limit = resolvePageSize(a.limit, a.cursor);
    // /storage/recent returns its continuation token as `nextToken` at the envelope
    // level but READS it back as `nextPage` (app.js, and the published registry row),
    // so the request dialect is `nextPage`; extractNextToken still finds `nextToken`
    // on the response. It echoes that token even when the list is exhausted, so only
    // advertise a next page when this page came back full. That rule is the OPPOSITE of
    // list_files' cursor-presence rule on purpose — the two endpoints do not satisfy the
    // same contract and must not be unified (CSD-667 AD7).
    const { data, nextCursor } = await client.postPaged("/storage/recent", { limit }, "nextPage", a.cursor);
    const hasMore = Array.isArray(data) && data.length >= limit;
    const render = summarizeListing(data);
    return textResult(withCursor(render.text, forwardCursor(hasMore ? nextCursor : undefined, data, render.complete)));
  },
};

// ---- get_file_metadata → POST /storage/object/detail (storageDetail, drive:read) ----

/**
 * The information ceiling CSD-638 set for an object the caller cannot be shown: absence and
 * access denial answer with the SAME sentence, so the pair cannot be used to probe for
 * objects in accounts the credential cannot reach. Copied verbatim from the server's own
 * wording (storage-api PublicApiErrorClassifier) so `get_file_metadata` and `get_file_tags`
 * answer identically for the same missing object — the tagging endpoint throws and reaches
 * the classifier, while `/storage/object/detail` swallows the miss and answers `null`.
 */
const OBJECT_NOT_AVAILABLE = "The specified object does not exist or is not available to your credential.";

/** `/storage/object/detail` answers `success:true, data:null` for an object it cannot resolve
 *  (StorageService.#getIndexedObjectDetail and ObjectRepository.getObject both swallow), and an
 *  endpoint that returns an empty payload is indistinguishable from it on the wire. */
function isEmptyDetail(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  return typeof data === "object" && Object.keys(data as Record<string, unknown>).length === 0;
}

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
    if (isEmptyDetail(data)) {
      const result = textResult(OBJECT_NOT_AVAILABLE);
      result.isError = true;
      return result;
    }
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
