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
