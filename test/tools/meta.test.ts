import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { allTools, hostedTools } from "../../src/tools/index";
import { createServer } from "../../src/server";
import { loadConfig } from "../../src/config";
import { VERSION } from "../../src/version";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";
import type { ToolDef, ToolResult } from "../../src/tools/types";

// CSD-586 Defect 6. The version exists in the process — it rides in the MCP handshake and in the
// startup line on stderr — but nothing a conversation can ask reaches it, so three of the six
// items on this ticket were reported against a build nobody could name. `get_version` is the one
// question that answers it, plus the host, because UAT and production genuinely diverge.

const here = dirname(fileURLToPath(import.meta.url));
const packageVersion = (JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")) as { version: string }).version;

const getVersion = allTools.find((tool) => tool.name === "get_version")!;

/** Values that appear nowhere else, so "it did not leak" is decidable by substring. */
const SENTINEL_KEY_ID = "AKIA-SENTINEL-KEY-ID-NEVER-RENDER-ME";
const SENTINEL_SECRET = "sentinel-api-key-secret-never-render-me";
const SENTINEL_PATH = "/deep/stage/path-that-is-not-a-host";
const API_HOST = "drive-api-uat.cloudsee.cloud";
const BASE_URL = `https://${API_HOST}${SENTINEL_PATH}`;

function sentinelConfig(): ReturnType<typeof loadConfig> {
  return loadConfig({
    CLOUDSEE_API_KEY_ID: SENTINEL_KEY_ID,
    CLOUDSEE_API_KEY_SECRET: SENTINEL_SECRET,
    CLOUDSEE_API_BASE_URL: BASE_URL,
    CLOUDSEE_LOG_LEVEL: "error",
  });
}

function firstText(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

/** Call `get_version` over a real MCP session, so the answer comes from the wiring the transport
 *  actually builds rather than from a context a test assembled by hand. */
async function callOverMcpSession(tools: ToolDef[]): Promise<string> {
  const server = createServer(sentinelConfig(), tools);
  const client = new Client({ name: "csd-586-tester", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({ name: "get_version", arguments: {} })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    return result.content[0]?.text ?? "";
  } finally {
    await client.close();
    await server.close();
  }
}

describe("get_version — registration", () => {
  it("is registered on both transports", () => {
    expect(allTools.map((tool) => tool.name)).toContain("get_version");
    expect(hostedTools.map((tool) => tool.name)).toContain("get_version");
  });

  // The counts the ticket pins: stdio carries upload_status on top of the hosted set.
  it("brings the registered set to 19 stdio / 18 hosted", () => {
    expect(allTools).toHaveLength(19);
    expect(hostedTools).toHaveLength(18);
  });

  it("is listed in the manifest Claude Desktop reads, with a description", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "../../manifest.json"), "utf8")) as {
      tools: Array<{ name: string; description: string }>;
    };
    expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(allTools.map((tool) => tool.name).sort());
    expect(manifest.tools.find((tool) => tool.name === "get_version")?.description?.trim()).toBeTruthy();
  });

  it("takes no arguments", () => {
    expect(Object.keys(getVersion.inputSchema)).toEqual([]);
  });

  // It reads this process's own state and nothing else, so there is no outside world to observe.
  it("is annotated read-only and closed-world", () => {
    expect(getVersion.annotations.readOnlyHint).toBe(true);
    expect(getVersion.annotations.openWorldHint).toBe(false);
  });
});

describe("get_version — what it reports", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("makes no API call", async () => {
    const post = vi.fn();
    const postPaged = vi.fn();

    await getVersion.handler({}, { client: { post, postPaged } as unknown as CloudSeeClient });

    expect(post).not.toHaveBeenCalled();
    expect(postPaged).not.toHaveBeenCalled();
  });

  it("reports the package version, not a string of its own", async () => {
    const result = await getVersion.handler({}, { client: { post: vi.fn() } as unknown as CloudSeeClient });

    expect(firstText(result)).toContain(VERSION);
    expect(VERSION).toBe(packageVersion);
    // A literal would satisfy the assertion above for exactly one release and then lie. The
    // version has one source (scripts/package-version.mjs, substituted at build time).
    const source = readFileSync(resolve(here, "../../src/tools/meta.ts"), "utf8");
    expect(source).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("reports the API host, never the full base URL", async () => {
    const result = await getVersion.handler(
      {},
      { client: { post: vi.fn() } as unknown as CloudSeeClient, serverInfo: { baseUrl: BASE_URL, toolCount: 19 } },
    );

    const text = firstText(result);
    expect(text).toContain(API_HOST);
    expect(text).not.toContain(SENTINEL_PATH);
    expect(text).not.toContain(BASE_URL);
    expect(text).not.toContain("https://");
  });

  it("reports how many tools this transport registered", async () => {
    const result = await getVersion.handler(
      {},
      { client: { post: vi.fn() } as unknown as CloudSeeClient, serverInfo: { baseUrl: BASE_URL, toolCount: 18 } },
    );

    expect(firstText(result)).toContain("18");
  });

  // A base URL is validated at config load, but the tool must not depend on that to stay safe:
  // an unparseable value answers "unknown" rather than echoing whatever the environment held.
  it.each([
    { label: "an unparseable value", baseUrl: "not-a-url-::::" },
    { label: "an empty value", baseUrl: "" },
  ])("answers unknown for $label instead of echoing it back", async ({ baseUrl }) => {
    const result = await getVersion.handler(
      {},
      { client: { post: vi.fn() } as unknown as CloudSeeClient, serverInfo: { baseUrl, toolCount: 19 } },
    );

    const text = firstText(result);
    expect(text).toContain("unknown");
    if (baseUrl) expect(text).not.toContain(baseUrl);
  });

  // Every other tool builds its context from `client` alone, and the tool tests in this suite do
  // the same. A missing serverInfo must degrade, not throw.
  it("still answers when no server info was supplied", async () => {
    const result = await getVersion.handler({}, { client: { post: vi.fn() } as unknown as CloudSeeClient });

    expect(firstText(result)).toContain(VERSION);
    expect(result.isError).toBeUndefined();
  });
});

describe("get_version — over a real MCP session", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers the stdio transport's own version, tool count and host", async () => {
    // Any outbound request at all is a defect for this tool, so make one impossible to miss.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("get_version must not reach the network"))));

    const text = await callOverMcpSession(allTools);

    expect(text).toContain(VERSION);
    expect(text).toContain(String(allTools.length));
    expect(text).toContain(API_HOST);
  });

  it("answers the hosted transport's own tool count, which is one lower", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("get_version must not reach the network"))));

    const text = await callOverMcpSession(hostedTools);

    expect(text).toContain(String(hostedTools.length));
    expect(text).not.toContain(String(allTools.length));
  });

  // The credential is the one thing a "which build am I talking to?" answer must never carry —
  // it is the value a user pastes into a public conversation to debug a connector.
  it("never discloses the API key id or its secret", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("get_version must not reach the network"))));

    const text = await callOverMcpSession(allTools);

    expect(text).not.toContain(SENTINEL_KEY_ID);
    expect(text).not.toContain(SENTINEL_SECRET);
    expect(text).not.toMatch(/AKIA/);
    expect(text).not.toMatch(/secret|api[_ -]?key/i);
  });
});
