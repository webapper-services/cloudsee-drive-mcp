import { z } from "zod";
import { summarize } from "./format";
import { bucketField, resolveBucket, textResult, type ToolDef } from "./types";

// download_file wraps POST /storage/object/download-url (getObjectUrl, drive:read +
// drive:download): a short-lived pre-signed URL, never AWS credentials — the right
// answer for a download. share_link wraps POST /shares/link/create (createShareLink,
// drive:write), which mints a revocable CloudSee share page instead. Both surface a
// URL (a capability link, not a secret); neither loads file bytes into the conversation.

// ---- download_file ----
const downloadSchema = z.object({
  bucketName: bucketField,
  filePath: z.string().min(1).describe("Object key (path) of the file to download, within the drive."),
  forceDownload: z.boolean().optional().describe("If true, the link forces an attachment download instead of inline view."),
  storageId: z.string().optional().describe("Optional storage/index id."),
});
const downloadFile: ToolDef = {
  name: "download_file",
  title: "Download file",
  description:
    "Get a short-lived pre-signed download URL for a file. Requires the drive (bucketName). The URL is time-limited and grants read access to that one object — share it with care. Returns the URL; it does not load file bytes into the conversation.",
  endpoint: { method: "POST", path: "/storage/object/download-url", scopes: ["drive:read", "drive:download"] },
  inputSchema: downloadSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = downloadSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const data = await client.post("/storage/object/download-url", {
      bucketName,
      filePath: a.filePath,
      download: a.forceDownload ?? false,
      storageId: a.storageId,
    });
    return textResult(summarize(data));
  },
};

// ---- share_link → POST /shares/link/create (createShareLink, drive:write) ----
// A token-backed share, NOT a pre-signed URL: the record lives in the Shares table,
// so access is re-checked against the creator's permission and the share can be revoked.

// The response also carries `token`, the raw share token — returned exactly once and
// a bearer secret for that share. Render an explicit projection, never the whole
// payload, so the token cannot reach the conversation or the client's transcript.
function shareView(data: unknown): Record<string, unknown> {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return {
    shareableLink: record.shareableLink,
    expiredTimeUTC: record.expiredTimeUTC,
    shareId: record.shareId,
  };
}

const shareSchema = z.object({
  bucketName: bucketField,
  filePath: z.string().min(1).describe("Object key (path) of the file to share, within the drive."),
  expireTime: z
    .number()
    .positive()
    .optional()
    .describe(
      "How long the link stays valid, in hours. Defaults to 12 hours when omitted; the server caps it at 30 days.",
    ),
  storageId: z.string().optional().describe("Optional storage/index id."),
});
const shareLink: ToolDef = {
  name: "share_link",
  title: "Create share link",
  description:
    "Create a shareable link to a file. Requires the drive (bucketName). Optionally set expireTime in hours (default 12 hours, capped at 30 days). Returns a CloudSee share page URL with its expiry and a share id. This is a write: it publishes the file to anyone who holds the link until the share expires, and no tool can list or revoke shares — an unwanted share can only be revoked from the CloudSee dashboard.",
  endpoint: { method: "POST", path: "/shares/link/create", scopes: ["drive:write"] },
  inputSchema: shareSchema.shape,
  // A Shares record is created server-side, so this is not read-only (CSD-668 F-08): a
  // readOnlyHint lets a client auto-run the tool without its permission prompt. Not
  // destructive — the share adds a capability, it removes nothing — which matches
  // create_folder's shape and keeps the tool out of the two-step confirm set.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = shareSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const data = await client.post("/shares/link/create", {
      bucketName,
      targetType: "object",
      filePath: a.filePath,
      ...(a.expireTime !== undefined ? { expireTime: a.expireTime } : {}),
      storageId: a.storageId,
    });
    return textResult(summarize(shareView(data)));
  },
};

export const downloadTools: ToolDef[] = [downloadFile, shareLink];
