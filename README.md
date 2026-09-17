# CloudSee Drive MCP server

[![CI](https://github.com/webapper-services/cloudsee-drive-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/webapper-services/cloudsee-drive-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@webapper/cloudsee-drive-mcp.svg)](https://www.npmjs.com/package/@webapper/cloudsee-drive-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
**[CloudSee Drive](https://www.cloudsee.cloud)** — connect your CloudSee account (a browser
interface for Amazon S3) to Claude Desktop and any MCP-compatible client, and manage your
files in natural language.

> Browse, search, download, share, upload, organize, and tag your CloudSee Drive files from
> your AI assistant — every destructive action must be approved through Claude Desktop's own
> tool-permission prompt before it runs.

📘 **New here?** The [Installation, Commands & Testing Guide](docs/GUIDE.md) walks through
install, configuration, every tool with examples, and how to test against a live API.

---

## Quickstart (≈5 minutes)

### 1. Get an API key

In the CloudSee Drive dashboard, create a public-API key. You'll receive a **key id**
(looks like `AKIA…`) and a **secret**. Copy both — the secret is shown only once.

### 2. Add the server to Claude Desktop

Open Claude Desktop → **Settings → Developer → Edit Config**, and add a `cloudsee-drive`
entry under `mcpServers` (no install needed — `npx` fetches the package on demand). Keep the
`@latest` suffix: it makes npm resolve the published version instead of running an older copy
it finds already installed on your PATH.

```json
{
  "mcpServers": {
    "cloudsee-drive": {
      "command": "npx",
      "args": ["-y", "@webapper/cloudsee-drive-mcp@latest"],
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

Requires **Node.js ≥ 20**. No native dependencies — works on macOS, Linux, and Windows.

### As a Claude Desktop extension (no config file)

The server is packaged as an **MCP Bundle (`.mcpb`)** — a one-click install that asks for your
API key in a form instead of making you edit JSON. Build one from this repo with:

```bash
npm run build:mcpb        # → build/cloudsee-drive-<version>.mcpb
```

Packing needs the MCPB CLI (`npm i -g @anthropic-ai/mcpb`); without it the script still stages
the bundle and prints the one command left to run. Open the resulting `.mcpb` with Claude
Desktop to install it.

### As an npm package

```bash
npm install -g @webapper/cloudsee-drive-mcp
```

A global install does not update itself — re-run that command to move to a newer release.

Pinning or upgrading the npm version pins the **server**; a client keeps the tool list it fetched
when it connected, so remove and re-add (or restart) the connector after an upgrade, and ask
`get_version` what is actually running before reporting on a tool's behaviour.

Or let `npx` fetch the package for you, as in the [Quickstart](#quickstart-5-minutes) above;
the `@latest` suffix used there is what makes npm resolve the published version rather than a
global install that happens to be on PATH.

On macOS that command usually fails the first time with `EACCES: permission denied, mkdir
'/usr/local/lib/node_modules/@webapper'`. That is npm's global prefix pointing at a directory
your user cannot write to — it is not specific to this package, and any system configured the
same way behaves the same. Either install with `sudo`, or point npm at a prefix you own:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc to keep it
npm install -g @webapper/cloudsee-drive-mcp
```

The `npx` form in the quickstart above sidesteps this entirely — it needs no global install.

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
| `list_buckets` | List the account's registered drives | read |
| `list_files` | List all files in a drive (recursive) | read |
| `browse_folder` | List a folder's contents (indexed view) | read |
| `search_files` | Find files/folders by name keyword | read |
| `recent_files` | List recently used files | read |
| `get_file_metadata` | Get a file's metadata | read |
| `get_file_tags` | Get a file's S3 tags | read |
| `download_file` | Get a temporary pre-signed download URL | download |
| `share_link` | Create a revocable CloudSee share page link, expiring after a chosen number of hours (default 12) | write |
| `upload_file` | Upload a file — see [Uploading](#uploading) | write |
| `upload_status` | Progress of a large upload running in the background (stdio only) | write |
| `create_folder` | Create a folder | write |
| `rename_file` | Rename a file/folder | write · **confirm** |
| `move_file` | Move (or copy) a file/folder | write · **confirm** (move) |
| `duplicate_file` | Duplicate a file | write |
| `delete_files` | Permanently delete objects | delete · **confirm** |
| `update_metadata` | Update a file's metadata | write · **confirm** |
| `restore_archived_file` | Un-archive a Glacier object | write · **confirm** |

### Uploading

`upload_file` has **one name and two shapes**, chosen by how the server is reached — you only
ever see the one that applies:

| Running as | Argument | Who reads the bytes | Size |
| --- | --- | --- | --- |
| **stdio** (this package, Claude Desktop / Claude Code) | `localPath` | The server, off your own disk | Any — over 8 MiB it uploads in 16 MiB parts |
| **hosted** (a remote connector) | `content` + `encoding` | The bytes travel in the request | ≤ 256 KB |

**Files over 8 MiB upload in the background.** An MCP client abandons a tool call after 60
seconds, so a large upload cannot be waited on — it would be reported as a timeout while it was
still succeeding. `upload_file` therefore returns an id straight away and keeps going; ask
`upload_status` for progress. The file is in the drive once that says `completed`. Parts go up
four at a time.

The upload lives in this server process, so quitting the MCP client cancels it.

The hosted shape exists because a remote server has no access to your disk, and a remote MCP
client is normally blocked from uploading to storage itself. For anything larger than a few
hundred kilobytes on a hosted connector, use the CloudSee web app.

Both shapes behave the same in two ways that matter:

- **Nothing is ever overwritten.** If the name is taken, the file is stored with a timestamp
  appended (`report (30-07-2026 14:05).md`) and the tool tells you the name it used.
- **The content type comes from the file name**, matching what storage signs the upload URL
  with. Passing your own would risk a signature mismatch, so the tool doesn't accept one.

> **Tip for `localPath`:** copy the name exactly. File names can contain characters that look
> like a plain space but aren't — macOS screen recordings, for instance, use `U+202F` before
> `AM`/`PM`. When a file isn't found, the error points at the near match and names the
> character.

### `list_files` ids are not stable — don't use them for mutation

`list_files` lists straight from storage and mints a new object id on every call. Never pass
that id to `rename_file`, `move_file`, `update_metadata`, or `delete_files`. Use `search_files`,
`browse_folder`, or `get_file_metadata` instead — their `StorageId` is a persisted id from the
search index and stays stable across calls. `recent_files` is **not** a source either: the id
it returns belongs to a different id space and those tools reject it.

### Destructive operations require confirmation

Tools marked **confirm** (delete, rename, move, update-metadata, restore) use **two-step
confirmation**: the first call returns a preview and makes **no changes**; the model must call
again with `confirm: true` to proceed. The two-step call itself is filled in by Claude, not by
you — it is not the actual approval gate.

**The real gate is Claude Desktop's own tool-permission prompt**, which appears before any
tool call runs. Four things worth knowing about it:

- **Denying it genuinely stops the operation** — the tool is never invoked with `confirm: true`.
- **Approving one destructive call does not approve a different one.** Approving a
  `rename_file` call does not pre-approve a later `delete_files` call — each call is gated
  independently.
- **"Allow for this task" is the prompt's default button**, and once clicked it covers that
  tool for the rest of the current chat — later calls to the same tool in the same
  conversation won't prompt again. Choose "Allow once" to review every call individually.
- This is still a client-side safety prompt — the CloudSee API authorizes every operation
  server-side; confirmation is not the security boundary.

## Privacy Policy

Full text: **[PRIVACY.md](PRIVACY.md)** ·
[hosted copy](https://github.com/webapper-services/cloudsee-drive-mcp/blob/main/PRIVACY.md)

In short — the server is a **conduit**, not a destination:

- **What it processes.** Only what a tool call needs: your API credentials (from the
  environment), and the file names, paths, metadata, tags or file contents involved in the
  operation you asked for.
- **What it stores.** Nothing. There is no database, cache or log of your files; each request is
  handled in memory and forgotten. Diagnostics go to stderr with the secret redacted.
- **Who else sees it.** Your AI client, which issues the tool calls, and the CloudSee Drive API /
  Amazon S3, which performs them. No analytics, no profiling, no model training, no resale.
- **Retention.** None by this server. Files and account data live in CloudSee Drive under its own
  policy; downloads are short-lived pre-signed URLs, and a share is a CloudSee-hosted page whose
  share record carries its own expiry.
- **Contact.** privacy@webapper.net · security reports per [SECURITY.md](SECURITY.md).

## Security

- Your API key id + secret are read from the environment and **held only in this local
  process**. The server **never logs the secret**, never returns it in tool output, and
  never writes it to a file. All diagnostics go to **stderr** (stdout is the MCP transport).
- File downloads return **short-lived pre-signed URLs**, never long-lived account
  credentials. (A pre-signed URL embeds the temporary, scoped signing token that is inherent
  to S3 SigV4 presigning — it expires with the link.)
- `share_link` returns a **CloudSee-hosted share page**, not a storage URL: the API records the
  share with an explicit expiry (`expiredTimeUTC`) and a `shareId`, so it can be revoked before
  it expires. The raw share token the API mints is never rendered into tool output.
- **Rotating an API key issues a new key id and secret together and revokes the old id
  immediately** — update both `CLOUDSEE_API_KEY_ID` and `CLOUDSEE_API_KEY_SECRET` after
  rotating; see [GUIDE.md §8 Troubleshooting](docs/GUIDE.md#8-troubleshooting).
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
- **`upload_file` differs by transport** (see [Uploading](#uploading)). Over stdio it takes a
  path and handles any size — one pre-signed PUT up to 8 MiB, multipart above that. On a hosted
  connector it takes the file's contents instead, capped at 256 KB.

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
