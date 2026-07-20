import { z } from "zod";
import { summarize } from "./format";
import { bucketField, resolveBucket, textResult, type ToolDef } from "./types";

// Both tools wrap POST /storage/object/download-url (getObjectUrl, drive:read +
// drive:download). The API returns a short-lived pre-signed URL, never AWS
// credentials. We surface the URL (a capability link, not a secret); the model
// can hand it to the user. We never download bytes into the conversation.

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

// ---- share_link ----
const shareSchema = z.object({
  bucketName: bucketField,
  filePath: z.string().min(1).describe("Object key (path) of the file to share, within the drive."),
  storageId: z.string().optional().describe("Optional storage/index id."),
});
const shareLink: ToolDef = {
  name: "share_link",
  title: "Create share link",
  description:
    "Create a shareable, time-limited link to a file (a pre-signed URL suitable for sharing). Requires the drive (bucketName). For richer share management (revocation, folder/prefix shares, expiry control) use the CloudSee dashboard.",
  endpoint: { method: "POST", path: "/storage/object/download-url", scopes: ["drive:read", "drive:download"] },
  inputSchema: shareSchema.shape,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, { client, defaultBucket }) => {
    const a = shareSchema.parse(args);
    const bucketName = resolveBucket(a.bucketName, defaultBucket);
    const data = await client.post("/storage/object/download-url", {
      bucketName,
      filePath: a.filePath,
      shareableLink: true,
      storageId: a.storageId,
    });
    return textResult(summarize(data));
  },
};

export const downloadTools: ToolDef[] = [downloadFile, shareLink];
