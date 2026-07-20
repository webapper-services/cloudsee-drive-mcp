# CloudSee Drive MCP server

[![CI](https://github.com/webapper-services/cloudsee-drive-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/webapper-services/cloudsee-drive-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@webapper/cloudsee-drive-mcp.svg)](https://www.npmjs.com/package/@webapper/cloudsee-drive-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
**[CloudSee Drive](https://www.cloudsee.cloud)** — connect your CloudSee account (a browser
interface for Amazon S3) to Claude Desktop and any MCP-compatible client, and manage your
files in natural language.

> Browse, search, download, share, upload, organize, and tag your CloudSee Drive files from
> your AI assistant — with explicit confirmation before anything destructive happens.

📘 **New here?** The [Installation, Commands & Testing Guide](docs/GUIDE.md) walks through
install, configuration, every tool with examples, and how to test against a live API.

---

## Quickstart (≈5 minutes)

### 1. Get an API key

In the CloudSee Drive dashboard, create a public-API key. You'll receive a **key id**
(looks like `AKIA…`) and a **secret**. Copy both — the secret is shown only once.

### 2. Add the server to Claude Desktop

Open Claude Desktop → **Settings → Developer → Edit Config**, and add a `cloudsee-drive`
entry under `mcpServers` (no install needed — `npx` fetches it on demand):

```json
{
  "mcpServers": {
    "cloudsee-drive": {
      "command": "npx",
      "args": ["-y", "@webapper/cloudsee-drive-mcp"],
      "env": {
        "CLOUDSEE_API_KEY_ID": "<your key id>",
        "CLOUDSEE_API_KEY_SECRET": "<your secret>",
        "CLOUDSEE_API_BASE_URL": "https://drive-api.cloudsee.cloud"
      }
    }
  }
}
```

### 3. Restart Claude Desktop and try it

> "List my CloudSee buckets, then show the most recent files."

That's it. The server runs locally on your machine; your API key never leaves it.

---

## Installation

`npx` (above) always runs the latest version. To install the `cloudsee-drive-mcp` binary
globally instead:

```bash
npm install -g @webapper/cloudsee-drive-mcp
```

Requires **Node.js ≥ 20**. No native dependencies — works on macOS, Linux, and Windows.

## Configuration

All configuration is via environment variables (set them in the Claude Desktop `env` block,
or a local `.env` for development — see [`.env.example`](.env.example)).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CLOUDSEE_API_KEY_ID` | ✅ | — | Your CloudSee Drive API key id. |
| `CLOUDSEE_API_KEY_SECRET` | ✅ | — | The matching API key secret. **Never commit this.** |
| `CLOUDSEE_API_BASE_URL` | — | `https://drive-api.cloudsee.cloud` | API base URL. UAT: `https://drive-api-uat.cloudsee.cloud`. |
| `CLOUDSEE_DEFAULT_BUCKET` | — | — | Default drive (S3 bucket) for tool calls that omit `bucketName`. Find the name in the CloudSee dashboard. |
| `CLOUDSEE_LOG_LEVEL` | — | `info` | `error` \| `warn` \| `info` \| `debug`. At **`debug`**, every API request + response is logged to stderr (secret redacted) for auditing. |
| `CLOUDSEE_TIMEOUT_MS` | — | `30000` | Per-request timeout in milliseconds. |

## Tools

Most tools operate on one **drive** (an S3 bucket): pass `bucketName`, or set
`CLOUDSEE_DEFAULT_BUCKET` once and omit it. `recent_files` and `list_buckets` don't need a drive.

| Tool | Description | Access |
| --- | --- | --- |
| `list_buckets` | List accessible buckets | read |
| `list_files` | List all files in a drive (recursive) | read |
| `browse_folder` | List a folder's contents (indexed view) | read |
| `search_files` | Find files/folders by name keyword | read |
| `recent_files` | List recently used files | read |
| `get_file_metadata` | Get a file's metadata | read |
| `get_file_tags` | Get a file's S3 tags | read |
| `download_file` | Get a temporary pre-signed download URL | download |
| `share_link` | Create a shareable, time-limited link | download |
| `upload_file` | Upload a local file (single or multipart) | write |
| `create_folder` | Create a folder | write |
| `rename_file` | Rename a file/folder | write · **confirm** |
| `move_file` | Move (or copy) a file/folder | write · **confirm** (move) |
| `duplicate_file` | Duplicate a file | write |
| `delete_files` | Permanently delete objects | delete · **confirm** |
| `update_metadata` | Update a file's metadata | write · **confirm** |
| `restore_archived_file` | Un-archive a Glacier object | write · **confirm** |

### Destructive operations require confirmation

Tools marked **confirm** (delete, rename, move, update-metadata, restore) use **two-step
confirmation**: the first call returns a preview and makes **no changes**; you must call again
with `confirm: true` to proceed. This is a client-side safety prompt — the CloudSee API
authorizes every operation server-side; confirmation is not the security boundary.

## Security

- Your API key id + secret are read from the environment and **held only in this local
  process**. The server **never logs the secret**, never returns it in tool output, and
  never writes it to a file. All diagnostics go to **stderr** (stdout is the MCP transport).
- File downloads/shares return **short-lived pre-signed URLs**, never AWS credentials.
- Report vulnerabilities per [`SECURITY.md`](SECURITY.md). Never paste a real key/secret into
  an issue.

## Status & known limitations

This wraps CloudSee Drive's public API (the `/v1/*` gateway).

- **Almost every tool needs a drive** (`bucketName`, or `CLOUDSEE_DEFAULT_BUCKET`). Without one,
  drive-scoped tools return a clear "specify a drive" message. `list_buckets` returns the
  drives your key can access — use it to discover drive names.
- **`browse_folder`/`search_files` use the search-indexed view** and can return empty for
  un-indexed content — use **`list_files`** for a complete, reliable listing of a drive.
- **Write/delete tools require an API key whose scopes include `drive:write` /
  `drive:delete`.** Admin-created keys carry these scopes; keys created under a User role are
  read/download-only, and the gateway denies out-of-scope calls with a clear
  `insufficient_scope` message.
- **`rename_file`, `move_file` (and copy) and `delete_files` are queued operations**: the tool
  returns a queue `RequestId` and the operation completes in the background, typically within
  1–2 minutes — verify by listing.
- `upload_file` handles files of any size: a single pre-signed PUT up to 8 MiB, and multipart
  (8 MiB parts) above that — chosen automatically.

## Development

```bash
npm install
npm test            # vitest: unit + tool↔contract drift tests
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # tsup → dist/ (ESM, with bin shebang)
npm run sync:contract  # regenerate contract/registry.snapshot.json from the API seed
node scripts/smoke.mjs # build first; spawns the server and lists tools over MCP
```

The **contract-drift test** (`test/contract/drift.test.ts`) fails the build if any tool drifts
from the committed API contract snapshot — so tool schemas can't silently diverge from the
real `/v1/*` surface.

## License

[MIT](LICENSE) © Webapper
