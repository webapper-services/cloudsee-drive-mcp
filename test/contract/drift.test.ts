import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allTools, hostedTools } from "../../src/tools/index";
import { MIME_TYPES, DEFAULT_CONTENT_TYPE, mimeForFileName } from "../../src/tools/mime";

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(resolve(here, "../../contract/registry.snapshot.json"), "utf8")) as {
  endpoints: Array<{ method: string; path: string; scopes: string[] }>;
};
const byKey = new Map(snapshot.endpoints.map((e) => [`${e.method} ${e.path}`, e]));

const mimeSnapshot = JSON.parse(readFileSync(resolve(here, "../../contract/mime.snapshot.json"), "utf8")) as {
  defaultContentType: string;
  entryCount: number;
  mimeTypes: Record<string, string>;
};

describe("tool ↔ contract drift", () => {
  it("every tool maps to a real data-plane endpoint with matching scope", () => {
    for (const tool of allTools) {
      const key = `${tool.endpoint.method} ${tool.endpoint.path}`;
      const ep = byKey.get(key);
      expect(ep, `tool "${tool.name}" → ${key} is not in the contract snapshot`).toBeTruthy();
      expect(ep?.scopes, `scope drift for "${tool.name}"`).toEqual(tool.endpoint.scopes);
    }
  });

  it("no tool targets the management plane (/api-keys/*)", () => {
    for (const tool of allTools) {
      expect(tool.endpoint.path.startsWith("/api-keys"), `${tool.name} must not hit the management plane`).toBe(false);
    }
  });

  it("dropped/renamed tools are absent", () => {
    const names = new Set(allTools.map((t) => t.name));
    for (const dropped of [
      "get_account",
      "update_account",
      "update_profile",
      "manage_api_keys",
      "list_user_buckets",
      "restore_file",
    ]) {
      expect(names.has(dropped), `"${dropped}" must not be registered`).toBe(false);
    }
  });

  it("includes the Glacier-named restore tool and the full grounded set", () => {
    const names = new Set(allTools.map((t) => t.name));
    expect(names.has("restore_archived_file")).toBe(true);
    expect(names.has("list_files")).toBe(true);
    expect(allTools.length).toBe(18);
  });

  it("every tool name is unique", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the hosted tool set maps to the same contract", () => {
    for (const tool of hostedTools) {
      const ep = byKey.get(`${tool.endpoint.method} ${tool.endpoint.path}`);
      expect(ep, `hosted tool "${tool.name}" is not in the contract snapshot`).toBeTruthy();
      expect(ep?.scopes, `scope drift for hosted "${tool.name}"`).toEqual(tool.endpoint.scopes);
    }
    // upload_status reports on background uploads, which only the stdio transport starts.
    expect(hostedTools.length).toBe(allTools.length - 1);
    expect(hostedTools.map((t) => t.name)).not.toContain("upload_status");
  });
});

// Storage signs a pre-signed upload URL with a content type it derives from the file name and
// returns only the URL, so this table has to match the service's byte for byte. Drift shows up
// as a 403 SignatureDoesNotMatch at PUT time, far from its cause — hence the assertion.
describe("MIME table ↔ storage service drift", () => {
  it("matches the committed snapshot of ExtensionUtil.mimeTypes", () => {
    expect(MIME_TYPES).toEqual(mimeSnapshot.mimeTypes);
  });

  it("agrees with the snapshot's fallback content type", () => {
    expect(DEFAULT_CONTENT_TYPE).toBe(mimeSnapshot.defaultContentType);
  });

  it("resolves names the way the service's getContentType does", () => {
    expect(mimeForFileName("report.md")).toBe("text/markdown");
    expect(mimeForFileName("REPORT.MD")).toBe("text/markdown"); // extension lower-cased
    expect(mimeForFileName("clip.mov")).toBe("video/quicktime");
    expect(mimeForFileName("archive.7z")).toBe("application/x-7z-compressed"); // quoted key
    expect(mimeForFileName("data.unknownext")).toBe(DEFAULT_CONTENT_TYPE);
    expect(mimeForFileName("LICENSE")).toBe(DEFAULT_CONTENT_TYPE); // no dot at all
  });
});
