import { describe, it, expect } from "vitest";
import { z } from "zod";
import { allTools } from "../../src/tools/index";

describe("tool definitions and input schemas", () => {
  it("every tool has valid metadata and a buildable schema", () => {
    for (const tool of allTools) {
      expect(tool.name, "snake_case tool name").toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.endpoint.method).toBe("POST");
      expect(tool.endpoint.path.startsWith("/")).toBe(true);
      expect(tool.endpoint.scopes.length).toBeGreaterThan(0);
      expect(() => z.object(tool.inputSchema)).not.toThrow();
    }
  });

  it("read/download tools are read-only; delete is destructive", () => {
    const byName = Object.fromEntries(allTools.map((t) => [t.name, t]));
    expect(byName["list_buckets"]?.annotations.readOnlyHint).toBe(true);
    expect(byName["download_file"]?.annotations.readOnlyHint).toBe(true);
    expect(byName["delete_files"]?.annotations.readOnlyHint).toBeFalsy();
    expect(byName["delete_files"]?.annotations.destructiveHint).toBe(true);
  });

  // CSD-668 F-08: share_link posts to /shares/link/create (drive:write) and creates a Shares
  // record, so it must not be annotated read-only — clients auto-run read-only tools without
  // their permission prompt. destructiveHint stays false (nothing is destroyed, and
  // confirm.test.ts requires a confirm input from every destructive tool).
  it("share_link is annotated as the write it is, not as a read", () => {
    const shareLink = allTools.find((t) => t.name === "share_link");
    expect(shareLink?.annotations.readOnlyHint).toBe(false);
    expect(shareLink?.annotations.destructiveHint).toBe(false);
    expect(shareLink?.endpoint.scopes).toEqual(["drive:write"]);
  });

  it("browse_folder enforces pageSize bounds", () => {
    const tool = allTools.find((t) => t.name === "browse_folder");
    const schema = z.object(tool!.inputSchema);
    expect(schema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(schema.safeParse({ pageSize: 50 }).success).toBe(true);
    expect(schema.safeParse({ pageSize: 999 }).success).toBe(false);
  });

  it("delete_files requires at least one object, each with key and storageId", () => {
    const tool = allTools.find((t) => t.name === "delete_files");
    const schema = z.object(tool!.inputSchema);
    expect(schema.safeParse({ objects: [] }).success).toBe(false);
    expect(schema.safeParse({ objects: [{ key: "x" }] }).success).toBe(false); // storageId is required per object
    expect(schema.safeParse({ objects: [{ key: "x", storageId: "os-1" }] }).success).toBe(true);
  });

  it("get_file_metadata requires an objectKey", () => {
    const tool = allTools.find((t) => t.name === "get_file_metadata");
    const schema = z.object(tool!.inputSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ objectKey: "a/b.txt" }).success).toBe(true);
  });

  it("list_files warns its id is unstable, in its own description", () => {
    const tool = allTools.find((t) => t.name === "list_files");
    expect(tool!.description).toMatch(/regenerated on every call/i);
  });

  // CSD-667 OQ-4: list_files exposes the same page-size knob as the other listing tools, with
  // the same bounds. Whatever the caller asks for, the renderer's own bound governs what is sent.
  it("list_files enforces the same pageSize bounds as browse_folder", () => {
    const tool = allTools.find((t) => t.name === "list_files");
    const schema = z.object(tool!.inputSchema);
    expect(schema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(schema.safeParse({ pageSize: 50 }).success).toBe(true);
    expect(schema.safeParse({ pageSize: 999 }).success).toBe(false);
  });
});

/** Every `.describe()` string reachable from a tool's input schema, including nested ones. */
function collectDescriptions(schema: z.ZodTypeAny): string[] {
  const found: string[] = [];
  if (schema.description) found.push(schema.description);
  if (schema instanceof z.ZodObject) {
    for (const field of Object.values(schema.shape as Record<string, z.ZodTypeAny>)) found.push(...collectDescriptions(field));
  } else if (schema instanceof z.ZodArray) {
    found.push(...collectDescriptions(schema.element as z.ZodTypeAny));
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    found.push(...collectDescriptions(schema.unwrap() as z.ZodTypeAny));
  } else if (schema instanceof z.ZodDefault) {
    found.push(...collectDescriptions(schema.removeDefault() as z.ZodTypeAny));
  }
  return found;
}

/** Everything the model reads about a tool: its description plus every field description. */
function guidanceText(toolName: string): string {
  const tool = allTools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`No such tool: ${toolName}`);
  return [tool.description, ...collectDescriptions(z.object(tool.inputSchema))].join("\n");
}

// CSD-668 WP-5: recent_files returns an id from a different id space than the one the
// mutable-op endpoints resolve, yet these five tools used to advertise it as a valid StorageId
// source. Without this pin the whole work package is unprotected — reverting all seven strings
// leaves every other suite green (verified by mutation). storageIdField is shared by
// rename_file/move_file/delete_files, so one regression there silently hits three tools.
describe("StorageId guidance names only the id spaces that actually work", () => {
  const TOOLS_CARRYING_STORAGE_ID_GUIDANCE = ["rename_file", "move_file", "delete_files", "update_metadata", "list_files"];

  it.each(TOOLS_CARRYING_STORAGE_ID_GUIDANCE)("%s never offers recent_files as a StorageId source", (toolName) => {
    const text = guidanceText(toolName);

    // Catches the reverted wording in both its spellings: "search_files, browse_folder,
    // recent_files" and "search_files / browse_folder / recent_files".
    expect(text, `${toolName} still lists recent_files alongside the working sources`).not.toMatch(
      /(?:search_files|browse_folder)[^.]{0,40}recent_files/,
    );
  });

  it.each(TOOLS_CARRYING_STORAGE_ID_GUIDANCE)("%s names recent_files explicitly as a non-source", (toolName) => {
    // §6.3: naming it as a NON-source beats deleting the mention, because the model has seen
    // the old description in cached schemas.
    expect(guidanceText(toolName)).toMatch(/recent_files[^.]{0,160}(?:will NOT work|will not work|different id space)/);
  });

  it.each(TOOLS_CARRYING_STORAGE_ID_GUIDANCE)("%s points at a route that does return a usable id", (toolName) => {
    expect(guidanceText(toolName)).toMatch(/get_file_metadata/);
  });
});
