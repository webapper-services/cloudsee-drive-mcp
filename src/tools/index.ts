import type { ToolDef } from "./types";
import { readTools } from "./read";
import { downloadTools } from "./download";
import { metaTools } from "./meta";
import { writeTools, writeToolsHosted } from "./write";

/**
 * The tool set for the **stdio** transport — what `npx cloudsee-drive-mcp` exposes. All tools
 * are callable end-to-end; write/delete tools require the matching scope on the API key
 * (the gateway RBAC is live).
 */
export const allTools: ToolDef[] = [...readTools, ...downloadTools, ...writeTools, ...metaTools];

/**
 * The tool set for the **hosted** transport (Lambda / the local HTTP dev server).
 *
 * Same names and same count as `allTools` — only `upload_file` differs, and it has to:
 * a hosted server cannot read the caller's disk (a path would resolve against the Lambda's
 * filesystem, which is both useless and an arbitrary-file-read vector), and a hosted MCP
 * client cannot perform a pre-signed PUT itself either — verified against production on
 * 2026-07-30, where Claude's sandbox refused it with
 * `Host not in allowlist: <bucket>.s3.amazonaws.com`. So the hosted variant carries the
 * bytes in the tool call and this server performs the PUT.
 */
export const hostedTools: ToolDef[] = [...readTools, ...downloadTools, ...writeToolsHosted, ...metaTools];

export type { ToolDef } from "./types";
