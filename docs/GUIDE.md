# CloudSee Drive MCP — Installation, Commands & Testing Guide

A practical, end-to-end guide to installing, configuring, running, and testing the
`@webapper/cloudsee-drive-mcp` server. For the short version see the
[README](../README.md); this document goes deeper and is grounded in real behavior
verified against UAT (`https://drive-api-uat.cloudsee.cloud`) on **2026-07-10**.

- [1. Prerequisites](#1-prerequisites)
- [2. Installation](#2-installation)
- [3. Configuration](#3-configuration)
- [4. Run & verify the server](#4-run--verify-the-server)
- [5. Tools & example commands](#5-tools--example-commands)
- [6. Testing against a live API](#6-testing-against-a-live-api)
- [7. What works today (grounded)](#7-what-works-today-grounded)
- [8. Troubleshooting](#8-troubleshooting)
- [9. Development & contract drift](#9-development--contract-drift)

---

## 1. Prerequisites

- **Node.js ≥ 20** (`node -v`). No native dependencies — macOS, Linux, Windows all work.
- A **CloudSee Drive API key** — a **key id** (`AKIA…`) and a **secret** (shown once).
  Create one in the CloudSee Drive dashboard. Keep the secret out of source control.
- An MCP client (e.g. **Claude Desktop**) for normal use, or just Node for testing.

---

## 2. Installation

### Option A — `npx` (recommended for Claude Desktop)

No install step; `npx` fetches and runs the latest published version on demand. Use the
Claude Desktop config in [§3](#3-configuration).

### Option B — global binary

```bash
npm install -g @webapper/cloudsee-drive-mcp
cloudsee-drive-mcp --help   # the bin entry; normally launched by an MCP client over stdio
```

---

## 3. Configuration

All configuration is via **environment variables**. Nothing is read from the command line,
and the secret is never written to disk by the server.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `CLOUDSEE_API_KEY_ID` | ✅ | — | Your API key id (`AKIA…`). |
| `CLOUDSEE_API_KEY_SECRET` | ✅ | — | The matching secret. **Never commit.** |
| `CLOUDSEE_API_BASE_URL` | — | `https://drive-api.cloudsee.cloud` | Prod default. UAT: `https://drive-api-uat.cloudsee.cloud`. |
| `CLOUDSEE_DEFAULT_BUCKET` | — | — | Default drive (S3 bucket) used when a tool omits `bucketName`. From the CloudSee dashboard. |
| `CLOUDSEE_LOG_LEVEL` | — | `info` | `error` \| `warn` \| `info` \| `debug`. Logs go to **stderr** only. At `debug`, every API request + response is logged (see [§6c](#6c-audit-every-api-call-request--response)). |
| `CLOUDSEE_TIMEOUT_MS` | — | `30000` | Per-request timeout (ms). |

### Claude Desktop

**Settings → Developer → Edit Config** opens `claude_desktop_config.json` — Windows:
`%APPDATA%\Claude\claude_desktop_config.json`, macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`. Add the `cloudsee-drive`
entry (merge into any existing `mcpServers`):

```json
{
  "mcpServers": {
    "cloudsee-drive": {
      "command": "npx",
      "args": ["-y", "@webapper/cloudsee-drive-mcp"],
      "env": {
        "CLOUDSEE_API_KEY_ID": "<your key id>",
        "CLOUDSEE_API_KEY_SECRET": "<your secret>",
        "CLOUDSEE_API_BASE_URL": "https://drive-api-uat.cloudsee.cloud"
      }
    }
  }
}
```

**Windows:** Claude Desktop frequently can't resolve `npx` directly — if the server doesn't
start, swap `command`/`args` for a `cmd /c` wrapper:

```json
"command": "cmd",
"args": ["/c", "npx", "-y", "@webapper/cloudsee-drive-mcp"],
```

Then **fully quit** Claude Desktop (from the system tray on Windows — not just the window) and
reopen. Confirm the server under **Settings → Developer**, then try:
*"Show my most recent CloudSee Drive files."* — lead with recent files. For the file tools,
give a drive name — ask for your buckets (`list_buckets`), pick one from the dashboard, or
set `CLOUDSEE_DEFAULT_BUCKET`.

### Local development (`.env`)

Copy [`.env.example`](../.env.example) to `.env` (git-ignored) and fill in the placeholders.
The `.env` is for your shell during development — the server itself only reads `process.env`.

---

## 4. Run & verify the server

### npm commands

| Command | What it does |
| --- | --- |
| `npm run build` | Compile `src/` → `dist/index.js` (ESM + bin shebang). |
| `npm run dev` | Build in watch mode. |
| `npm start` | `node dist/index.js` — launch the stdio server. |
| `npm test` | Vitest: unit + tool↔contract drift tests. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` / `npm run lint:fix` | ESLint. |
| `npm run sync:contract` | Regenerate `contract/registry.snapshot.json` from the API seed. |
| `node scripts/smoke.mjs` | Build first; spawns the server and lists tools over a real MCP handshake (offline — uses placeholder creds, makes no API call). |

### Smoke test (no credentials needed)

```bash
npm run build && node scripts/smoke.mjs
```

Expected: `tools registered: 18`, the tool list, the destructive set, then `SMOKE OK`.

### Manual one-shot over stdio (JSON-RPC)

The server speaks MCP over stdio: **stdout is the transport, stderr is logs.** You normally
don't hand-drive it, but to confirm it starts and lists tools:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | CLOUDSEE_API_KEY_ID=x CLOUDSEE_API_KEY_SECRET=y node dist/index.js
```

(`tools/list` makes no API call, so placeholder creds are fine here.)

---

## 5. Tools & example commands

18 tools. "Access" is the seed scope the backing endpoint requires. **confirm** = two-step
confirmation (see below). Most tools need a **drive** — pass `bucketName` (or set
`CLOUDSEE_DEFAULT_BUCKET`); `recent_files` and `list_buckets` don't.

| Tool | What it does | Access | Example prompt |
| --- | --- | --- | --- |
| `list_buckets` | List the account's registered drives | read | "What CloudSee drives can I access?" |
| `list_files` | List all files in a drive (recursive) | read | "List the files in the `max-2778abc0` drive." |
| `browse_folder` | List a folder (indexed view) | read | "Show what's in `reports/` on drive `acme-docs`." |
| `search_files` | Find by name keyword | read | "Find files named *invoice* in drive `acme-docs`." |
| `recent_files` | Recently used files | read | "What are my most recent files?" |
| `get_file_metadata` | One file's metadata | read | "Get details for `reports/q3.pdf`." |
| `get_file_tags` | A file's S3 tags | read | "What tags are on `reports/q3.pdf`?" |
| `download_file` | Temporary pre-signed download URL | download | "Give me a download link for `q3.pdf`." |
| `share_link` | Revocable CloudSee share page link, expiring after a chosen number of hours (default 12) | write | "Create a 48-hour share link for `q3.pdf`." |
| `upload_file` | Upload a file (path over stdio, contents when hosted) | write | "Upload `./q3.pdf` to `reports/`." |
| `upload_status` † | Progress of a large upload running in the background | write | "How's that upload going?" |
| `create_folder` | Create a folder | write | "Create a `2026/` folder." |
| `rename_file` | Rename a file/folder | write · **confirm** | "Rename `old.pdf` to `new.pdf`." |
| `move_file` | Move (or copy) a file/folder | write · **confirm** (move) | "Move `a.pdf` into `archive/`." |
| `duplicate_file` | Duplicate a file | write | "Duplicate `q3.pdf`." |
| `delete_files` | Permanently delete objects | delete · **confirm** | "Delete `tmp/scratch.txt`." |
| `update_metadata` | Update a file's metadata | write · **confirm** | "Set category=Finance on `q3.pdf`." |
| `restore_archived_file` | Un-archive a Glacier object | write · **confirm** | "Restore archived `cold/2019.zip`." |

### Destructive confirmation flow

Tools marked **confirm** make **no change** on the first call — they return a preview. Call
again with `confirm: true` to execute:

```jsonc
// 1st call → preview only, nothing deleted
{ "name": "delete_files", "arguments": { "objects": [{ "key": "tmp/scratch.txt", "storageId": "<StorageId from search_files/browse_folder/recent_files>" }] } }
// 2nd call → queues the delete (returns a RequestId; completes in the background)
{ "name": "delete_files", "arguments": { "objects": [{ "key": "tmp/scratch.txt", "storageId": "<StorageId>" }], "confirm": true } }
```

**The safety boundary is not this two-step call — it's Claude Desktop's own tool-permission
prompt.** Claude fills in `confirm: true` itself once you approve the call in that prompt.
Denying the prompt genuinely stops the operation; approving one destructive call (e.g. a
rename) does not approve a different one (e.g. a delete) — each call is gated independently.
**"Allow for this task" is the prompt's default button** and, once clicked, covers that tool
for the rest of the current chat, not just the call in front of you — choose "Allow once" to
review every call. Even so, this is a **client-side safety prompt, not the security
boundary** — the CloudSee API authorizes every operation server-side regardless of what the
prompt shows.

### Queued write operations (rename / move / copy / delete)

`rename_file`, `move_file` (move or copy) and `delete_files` are **asynchronous**: the call
enqueues the operation and returns a queue `RequestId`; the operation completes in the
background, typically within 1–2 minutes — verify by listing. They address the object by its
exact `objectKey` (from any listing tool; folders keep their trailing slash) **plus** its
`storageId` — the `StorageId` field returned by the indexed listing tools (`search_files`,
`browse_folder`, `recent_files`; the id from `list_files` will **not** work, because
`list_files` lists straight from storage and mints a brand-new id for every object on every
call — it is never the same id twice):

- `rename_file`: `objectKey` + `newName` + `storageId` + `confirm`
- `move_file`: `objectKey` + `destinationPath` + `storageId` (+ `asCopy` to copy; a move needs `confirm`)
- `delete_files`: `objects: [{ key, isFolder?, storageId }]` + `confirm` (one queued request per object)

### Pagination (opaque cursor)

List/search/recent tools return a single opaque `cursor` when more results exist:

> ↪ More results available. Call this tool again with `cursor="…"` for the next page.

Pass that exact string back as `cursor` to fetch the next page. The cursor is opaque and
**operation-specific** — a cursor minted by one tool is rejected by another. (Internally the
server normalizes the API's several pagination dialects — `nextPage`, `marker`,
`lastEvaluatedKey`, `pageToken`, `nextToken` — into this one cursor.)

---

## 6. Testing against a live API

Two layers: a **direct HTTP probe** (isolates credentials + endpoint) and an **end-to-end MCP
drive** (the full transport → client → API path). Keep the secret in env; never paste it into
a file.

### 6a. Direct probe — confirm the key works

The data plane is RPC: `POST {baseUrl}/v1/{noun}/{verb}` with `X-Api-Key-Id` /
`X-Api-Key-Secret` headers and a JSON body. A `200` with `{"success":true,…}` means the key
authenticates.

Every `/v1/*` call also needs an `X-Api-Key` header carrying the **same value as the key id** —
the gateway meters the usage plan on it and rejects the request before the API sees it when it
is missing. `/v1/auth/verify` is the one exempt route, so a credential can be checked first.

**PowerShell (Windows):**

```powershell
$h = @{ 'X-Api-Key'=$env:CLOUDSEE_API_KEY_ID; 'X-Api-Key-Id'=$env:CLOUDSEE_API_KEY_ID; 'X-Api-Key-Secret'=$env:CLOUDSEE_API_KEY_SECRET; 'Content-Type'='application/json' }
Invoke-WebRequest -Uri 'https://drive-api-uat.cloudsee.cloud/v1/storage/recent' -Method Post -Headers $h -Body '{"limit":5}' -SkipHttpErrorCheck |
  Select-Object -ExpandProperty Content
```

**curl (macOS/Linux):**

```bash
curl -s https://drive-api-uat.cloudsee.cloud/v1/storage/recent \
  -H "X-Api-Key: $CLOUDSEE_API_KEY_ID" \
  -H "X-Api-Key-Id: $CLOUDSEE_API_KEY_ID" \
  -H "X-Api-Key-Secret: $CLOUDSEE_API_KEY_SECRET" \
  -H 'Content-Type: application/json' -d '{"limit":5}'
```

A `401 {"error":{"code":"unauthorized"}}` means the key id/secret is wrong, inactive, or
expired.

### 6b. End-to-end MCP drive

Build first, then drive the built server with an MCP client exactly as Claude Desktop does.
Save as `e2e.mjs` in the repo root and run with the creds in env:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, CLOUDSEE_LOG_LEVEL: "error" }, // creds inherited from env
});
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools: ${tools.length}`);

const res = await client.callTool({ name: "recent_files", arguments: { limit: 5 } });
console.log(res.content.map((c) => c.text).join("\n"));

await client.close();
```

```bash
# macOS/Linux
CLOUDSEE_API_KEY_ID=… CLOUDSEE_API_KEY_SECRET=… CLOUDSEE_API_BASE_URL=https://drive-api-uat.cloudsee.cloud node e2e.mjs
```

```powershell
# Windows PowerShell (set in the same invocation — shell state doesn't persist between calls)
$env:CLOUDSEE_API_KEY_ID='…'; $env:CLOUDSEE_API_KEY_SECRET='…'; $env:CLOUDSEE_API_BASE_URL='https://drive-api-uat.cloudsee.cloud'; node e2e.mjs
```

Delete the throwaway script afterward; don't commit it.

### 6c. Audit every API call (request + response)

Set **`CLOUDSEE_LOG_LEVEL=debug`** and the server logs each call to **stderr** — the exact
outbound request (`→ POST …` with the JSON body) and the raw API response (`← 200 …`). Auth
headers and the API secret are never logged (and the secret is redacted as a backstop). This is
the definitive way to see what the MCP actually sent and what the API returned — as opposed to
what the model rendered in chat.

In Claude Desktop, add `"CLOUDSEE_LOG_LEVEL": "debug"` to the server's `env` block; Claude
Desktop captures the server's stderr to its MCP log:
- **Windows:** `%APPDATA%\Claude\logs\` (look for `mcp-server-cloudsee-drive.log` / `mcp*.log`)
- **macOS:** `~/Library/Logs/Claude/`

Example (a `list_files` call — note the recursive whole-drive listing, files at the drive root):

```text
[cloudsee-drive-mcp] DEBUG: → POST https://drive-api-uat.cloudsee.cloud/v1/storage/bucket/files {"bucketName":"max-2778abc0","deepQuery":true}
[cloudsee-drive-mcp] DEBUG: ← 200 POST /v1/storage/bucket/files {"success":true,"data":[{"Name":"abc-01.pdf","Parent":"","Path":"abc-01.pdf","StorageClass":"GLACIER_IR",…}]}
```

Large bodies are truncated at 4000 chars so a big listing can't flood the log.

---

## 7. What works today (grounded)

Verified against UAT on 2026-07-10 — reads with a User-role (`drive:read`/`download`) key,
writes with an admin key carrying `drive:write`/`drive:delete`:

| Capability | Status | Notes |
| --- | --- | --- |
| Auth (key id + secret) | ✅ Works | `200 {success:true}`; bad secret → clean `401`, secret never echoed. |
| `recent_files` | ✅ Live data | Per-user index; the one read tool that needs **no** drive. |
| `list_files` (with a drive) | ✅ Live data | Recursive listing straight from storage — the reliable way to see a drive's files. |
| `get_file_metadata`, `get_file_tags` (with a drive) | ✅ Live data | Real per-object metadata / S3 tags. |
| `download_file` (with a drive) | ✅ Live data | Real short-lived pre-signed URLs (never AWS keys). |
| `share_link` (with a drive) | ✅ Live | A CloudSee-hosted share page, not a raw S3 URL — returns the link, its `expiredTimeUTC` and a `shareId`, and stays revocable from the dashboard. |
| `browse_folder`, `search_files` (with a drive) | ✅ Call succeeds | Use the **search index**, so they can return empty for un-indexed content — prefer `list_files`. Browsing a drive **root** (no `path`) can still 500 (a backend quirk on empty prefix); give a sub-folder path. |
| `list_buckets` | ✅ Live data | Returns the drives the API key can access — use it to discover drive names. |
| Write/delete mutations | ✅ Live | Verified end-to-end with a key carrying `drive:write`/`drive:delete`. Keys without the scope get a clean `insufficient_scope` denial. rename/move/copy/delete are **queued** (RequestId; completes within ~1–2 minutes). |

Other notes:

- **A drive is required** for everything except `recent_files` and `list_buckets` — pass
  `bucketName`, or set `CLOUDSEE_DEFAULT_BUCKET`. Missing → a clear "specify a drive" message.
- **`upload_file` has two shapes, one per transport.** Over **stdio** it takes `localPath` and
  reads the file off the machine running the server — your own — handling any size (one
  pre-signed PUT up to 8 MiB, 8 MiB parts above that). On a **hosted** connector that is
  meaningless (the path would resolve against the server's disk) and a remote client cannot
  perform the pre-signed PUT itself either — verified against production 2026-07-30, refused
  with `Host not in allowlist: <bucket>.s3.amazonaws.com`. So the hosted shape takes `content` +
  `encoding` instead, capped at 256 KB; larger files go through the web app.
- **Neither shape overwrites.** A taken name becomes `report (30-07-2026 14:05).md`, and the
  tool reports the name it used.
- **The content type is derived from the file name**, not accepted as input — storage signs the
  upload URL with a type it derives the same way, and any other value gets a
  `403 SignatureDoesNotMatch` from S3.
- **`localPath` names must be exact.** A file name can contain characters that render like a
  space but aren't (macOS screen recordings use `U+202F` before `AM`/`PM`). On a miss the error
  lists the near match and names the offending character.
- **`recent_files` pagination** reflects the backend's token: it advertises a next page only
  when a page comes back full, and replays the API's continuation token verbatim. On very
  small datasets the backend may return the same token repeatedly.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Authentication failed (HTTP 401)` | Wrong/inactive/expired key id or secret. Re-check both env vars; the secret is shown only once at creation. |
| `No CloudSee drive specified` | A drive-scoped tool was called without a drive. Pass `bucketName`, or set `CLOUDSEE_DEFAULT_BUCKET`. |
| `…contact the system administrator` from a list/browse call | Usually a missing drive — pass `bucketName`. With a drive, browsing a **root** (empty `path`) can still 500; give a sub-folder `path`, or use `list_files` for the whole drive. |
| A write/delete/rename/move is denied (`insufficient_scope`) | The API key lacks the tool's scope (`drive:write` / `drive:delete`). Keys created under a User role are read/download-only — use an admin-created key with the write scopes. |
| A rename/move/copy/delete "succeeded" but the listing looks unchanged | These operations are queued: the tool returns a RequestId and the change completes in the background, typically within 1–2 minutes. Re-list after a short wait. |
| `Pagination cursor is not valid for this operation` | You passed a `cursor` from a different tool. Cursors are operation-specific; re-page the same tool. |
| Server won't start: "not configured" | A required env var is missing — set `CLOUDSEE_API_KEY_ID` and `CLOUDSEE_API_KEY_SECRET`. |
| Server won't start on **Windows** (`npx` not found) | Claude Desktop can't resolve `npx` directly. Use `"command": "cmd", "args": ["/c","npx","-y","@webapper/cloudsee-drive-mcp"]`, or `npm i -g @webapper/cloudsee-drive-mcp` and point `command` at the installed binary. |
| No tools icon / server not listed | The icon only appears once a server connects. Check **Settings → Developer**; if absent, the config wasn't read — validate the JSON and fully restart from the system tray. |
| Tool calls hang then error | Network/endpoint reachability or a slow API. Raise `CLOUDSEE_TIMEOUT_MS`; check the base URL. |
| Garbled MCP output | Something wrote to **stdout** (the transport). All app logs must go to stderr; set `CLOUDSEE_LOG_LEVEL=error` to quiet them. |
| "Where did this result come from?" / want to audit calls | Set `CLOUDSEE_LOG_LEVEL=debug` — every API request + response is logged to stderr (§6c). |
| A result looks wrong vs. the web app | `list_files` lists the **whole drive recursively** (root + all folders); the web app shows one folder. Compare the debug log (§6c) against the dashboard. |

### Rotating an API key invalidates the old key id, not just the secret

Rotating a key in the CloudSee dashboard mints a **new key id and a new secret together**; the
old key id is revoked in the same operation, immediately — there is no grace period. If you
update only `CLOUDSEE_API_KEY_SECRET` in `claude_desktop_config.json` after rotating and leave
the old `CLOUDSEE_API_KEY_ID` in place, the server authenticates with a dead key id and you get
a clean `Authentication failed (HTTP 401)` (the row above) with no indication rotation was the
cause. **Update both `CLOUDSEE_API_KEY_ID` and `CLOUDSEE_API_KEY_SECRET` together whenever you
rotate.**

**Then restart the connector.** The server reads its environment once, at process start, so an
edit to `claude_desktop_config.json` changes nothing until the MCP client reloads it. If the
401 persists after you have corrected both values, this is usually why.

---

## 9. Development & contract drift

```bash
npm install
npm run lint && npm run typecheck && npm test && npm run build
```

The **contract-drift test** (`test/contract/drift.test.ts`) fails the build if any tool's
backing path/method/scope drifts from the committed `contract/registry.snapshot.json` — so
tool schemas can't silently diverge from the real `/v1/*` surface. After the API seed changes,
run `npm run sync:contract` to refresh the snapshot, then reconcile any tool differences.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution flow and
[SECURITY.md](../SECURITY.md) for reporting vulnerabilities.
