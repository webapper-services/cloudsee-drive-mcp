import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allTools } from "../src/tools/index";
import { loadConfig } from "../src/config";
import { VERSION } from "../src/version";

// manifest.json is what Claude Desktop reads when the extension is installed — the tool list
// shown to the user, and the env wiring the server actually starts with. Nothing checks it at
// runtime, so a stale entry ships silently. These assertions are that check.

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(here, "../manifest.json"), "utf8")) as {
  manifest_version: string;
  name: string;
  version: string;
  privacy_policies: string[];
  icon?: string;
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[]; env: Record<string, string> } };
  user_config: Record<string, { type: string; required?: boolean; sensitive?: boolean; default?: string }>;
  tools: Array<{ name: string; description: string }>;
};
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as { version: string };

describe("MCPB manifest", () => {
  it("declares a manifest version that supports privacy_policies (0.2+)", () => {
    const [major, minor] = manifest.manifest_version.split(".").map(Number);
    expect(major > 0 || minor >= 2, `manifest_version ${manifest.manifest_version} predates privacy_policies`).toBe(true);
  });

  // "Missing or incomplete privacy policies result in immediate rejection" — directory policy.
  it("points at an https privacy policy", () => {
    expect(manifest.privacy_policies.length).toBeGreaterThan(0);
    for (const url of manifest.privacy_policies) expect(url).toMatch(/^https:\/\//);
  });

  it("ships the same version as the package it is built from", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  // The extension shows one version in the UI while the server announces another in the MCP
  // handshake — they must be the same number, or nobody can tell what is actually installed.
  // (A hand-maintained copy drifted for five releases before this assertion existed.)
  it("agrees with the version the server announces at runtime", () => {
    expect(VERSION).toBe(pkg.version);
    expect(manifest.version).toBe(VERSION);
  });

  it("lists exactly the tools the server registers", () => {
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(allTools.map((t) => t.name).sort());
  });

  it("gives every listed tool a description", () => {
    for (const tool of manifest.tools) {
      expect(tool.description?.trim(), `${tool.name} needs a description`).toBeTruthy();
    }
  });

  // A listing needs artwork, and the icon is the one asset that ships inside the bundle rather
  // than being uploaded to a portal — so if it is wrong, it is wrong everywhere.
  it("declares an icon that exists and is a square PNG", () => {
    expect(manifest.icon, "manifest.json must declare an icon").toBeTruthy();
    const bytes = readFileSync(resolve(here, "..", manifest.icon!));

    expect(bytes.subarray(0, 8).toString("hex"), "not a PNG").toBe("89504e470d0a1a0a");
    expect(bytes.toString("ascii", 12, 16), "IHDR must be the first chunk").toBe("IHDR");

    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect(width, `icon is ${width}x${height}, must be square`).toBe(height);
    expect(width).toBeGreaterThanOrEqual(128);
  });

  it("runs the bundled stdio entry point", () => {
    expect(manifest.server.type).toBe("node");
    // build-mcpb.mjs stages the bundle at this exact path inside the archive.
    expect(manifest.server.entry_point).toBe("server/index.js");
    expect(manifest.server.mcp_config.args[0]).toBe("${__dirname}/server/index.js");
  });

  it("marks the API secret sensitive and both credentials required", () => {
    expect(manifest.user_config.api_key_id.required).toBe(true);
    expect(manifest.user_config.api_key_secret.required).toBe(true);
    expect(manifest.user_config.api_key_secret.sensitive).toBe(true);
    // The id is not a secret, so flagging it would just make it unreadable for no gain.
    expect(manifest.user_config.api_key_id.sensitive).not.toBe(true);
  });

  it("wires every env var from a declared user_config key", () => {
    for (const [name, value] of Object.entries(manifest.server.mcp_config.env)) {
      const key = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/.exec(value)?.[1];
      expect(key, `${name} must come from a user_config value, got ${value}`).toBeTruthy();
      expect(Object.keys(manifest.user_config), `${name} → unknown user_config.${key}`).toContain(key!);
    }
  });

  it("supplies every env var the server requires to start", () => {
    // The real proof: feed the manifest's env wiring to the real loader, with blanks for the
    // optional fields exactly as MCPB substitutes them when a user leaves them empty.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(manifest.server.mcp_config.env)) {
      const key = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/.exec(value)![1];
      const cfg = manifest.user_config[key]!;
      env[name] = cfg.required ? "provided-by-user" : (cfg.default ?? "");
    }
    expect(() => loadConfig(env)).not.toThrow();
  });

  it("still starts when every optional field is left blank", () => {
    // MCPB substitutes an unset optional as "", not as an absent key — see config.ts.
    const cfg = loadConfig({
      CLOUDSEE_API_KEY_ID: "id",
      CLOUDSEE_API_KEY_SECRET: "secret",
      CLOUDSEE_API_BASE_URL: "",
      CLOUDSEE_DEFAULT_BUCKET: "",
      CLOUDSEE_LOG_LEVEL: "",
    });
    expect(cfg.baseUrl).toBe("https://drive-api.cloudsee.cloud");
    expect(cfg.defaultBucket).toBeUndefined();
    expect(cfg.logLevel).toBe("info");
  });
});

// server.json is the MCP registry listing. Like manifest.json it repeats the version and
// nothing reads it at runtime, so drift is invisible until someone installs the wrong
// number. scripts/sync-version.mjs keeps all three in step on every `npm version`; this is
// the assertion that fails if that wiring is ever removed.
describe("MCP registry listing", () => {
  const registry = JSON.parse(readFileSync(resolve(here, "../server.json"), "utf8")) as {
    name: string;
    version: string;
    packages: Array<{ identifier: string; version: string }>;
  };

  it("ships the same version as the package, everywhere it repeats it", () => {
    expect(registry.version).toBe(pkg.version);
    for (const entry of registry.packages) expect(entry.version, entry.identifier).toBe(pkg.version);
  });
});
