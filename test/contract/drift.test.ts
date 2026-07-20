import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allTools } from "../../src/tools/index";

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(resolve(here, "../../contract/registry.snapshot.json"), "utf8")) as {
  endpoints: Array<{ method: string; path: string; scopes: string[] }>;
};
const byKey = new Map(snapshot.endpoints.map((e) => [`${e.method} ${e.path}`, e]));

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
    expect(allTools.length).toBe(17);
  });

  it("every tool name is unique", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
