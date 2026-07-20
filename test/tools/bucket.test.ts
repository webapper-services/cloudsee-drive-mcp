import { describe, it, expect } from "vitest";
import { resolveBucket } from "../../src/tools/types";
import { CloudSeeError } from "../../src/errors";
import { allTools } from "../../src/tools/index";

describe("drive (bucket) resolution", () => {
  it("prefers the bucket parsed from input over the configured default", () => {
    expect(resolveBucket("from-input", "from-config")).toBe("from-input");
  });

  it("falls back to the configured default only when input is absent", () => {
    expect(resolveBucket(undefined, "from-config")).toBe("from-config");
  });

  it("throws an actionable error when neither is provided (never hardcoded)", () => {
    expect(() => resolveBucket(undefined, undefined)).toThrow(CloudSeeError);
    expect(() => resolveBucket("", "")).toThrow(/drive/i);
  });
});

describe("bucket-scoped tools collect bucketName from input", () => {
  const byName = Object.fromEntries(allTools.map((t) => [t.name, t]));

  const BUCKET_SCOPED = [
    "browse_folder",
    "search_files",
    "list_files",
    "get_file_metadata",
    "get_file_tags",
    "download_file",
    "share_link",
    "upload_file",
    "create_folder",
    "rename_file",
    "move_file",
    "duplicate_file",
    "delete_files",
    "update_metadata",
    "restore_archived_file",
  ];

  it("expose a bucketName input field", () => {
    for (const name of BUCKET_SCOPED) {
      const tool = byName[name];
      expect(tool, name).toBeTruthy();
      expect(Object.keys(tool!.inputSchema), `${name} should accept bucketName`).toContain("bucketName");
    }
  });

  it("recent_files and list_buckets do NOT require a drive", () => {
    expect(Object.keys(byName["list_buckets"]!.inputSchema)).not.toContain("bucketName");
    expect(Object.keys(byName["recent_files"]!.inputSchema)).not.toContain("bucketName");
  });
});
