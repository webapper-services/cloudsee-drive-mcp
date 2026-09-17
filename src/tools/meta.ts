import { VERSION } from "../version";
import { textResult, type ToolDef } from "./types";

// ---- get_version → reads this process's own identity; makes no API call ----
// CSD-586 D6. The version exists in the process (it rides in the MCP handshake and the startup
// line on stderr) but nothing a conversation can ask reaches it, so three of the six items on
// this ticket were reported against a build nobody could name. The host answers the other half
// of that question — UAT and production genuinely diverge — and is reported as a HOST only:
// the key id and the secret are not part of this tool's answer.

const UNKNOWN = "unknown";

/** Host of the configured base URL, never the full URL. Any unparseable value answers
 *  `unknown` rather than echoing back whatever the environment happened to hold. */
function apiHost(baseUrl: string | undefined): string {
  if (!baseUrl) return UNKNOWN;
  try {
    return new URL(baseUrl).host || UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

const getVersion: ToolDef = {
  name: "get_version",
  title: "Server version",
  description:
    "Report the version of this CloudSee Drive connector, how many tools it registered, and which CloudSee API host it is configured against. Answer this from the tool rather than from the package version you believe is installed: a client keeps the tool list it fetched when it connected, so an upgraded server can still be described by an older list until the connector is reconnected. Takes no arguments, makes no API call and never reports the API key or its secret.",
  // No endpoint of its own; declared against the drive listing it reports the host for, so the
  // contract-drift test still has something real to match (the `upload_status` precedent).
  endpoint: { method: "POST", path: "/storage/drives", scopes: ["drive:read"] },
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_args, { serverInfo }) => {
    return textResult(
      [
        `cloudsee-drive-mcp ${VERSION}`,
        `tools     ${serverInfo ? serverInfo.toolCount : UNKNOWN}`,
        `api host  ${apiHost(serverInfo?.baseUrl)}`,
      ].join("\n"),
    );
  },
};

export const metaTools: ToolDef[] = [getVersion];
