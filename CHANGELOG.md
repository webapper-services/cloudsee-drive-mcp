## [3.0.1](https://github.com/webapper-services/cloudsee-drive-mcp/compare/v3.0.0...v3.0.1) (2026-09-14)


### Bug Fixes

* **update_metadata:** keep the fields the caller did not send ([4873a5a](https://github.com/webapper-services/cloudsee-drive-mcp/commit/4873a5ad449a71b3a91d4d316cb1f03d75bb2fae))

# [3.0.0](https://github.com/webapper-services/cloudsee-drive-mcp/compare/v2.0.2...v3.0.0) (2026-09-14)


### Bug Fixes

* restore paging, folder lookup, sharing and result bounding ([4383016](https://github.com/webapper-services/cloudsee-drive-mcp/commit/438301690957ffd148224846d06a46b6987f46ca))
* **share_link:** let the caller choose how long a share lasts ([26ee643](https://github.com/webapper-services/cloudsee-drive-mcp/commit/26ee643547f2e48f0d6d856a4c65cca74fb475b9))


### BREAKING CHANGES

* share_link creates a token-backed CloudSee share and returns
a CloudSee share page URL with an expiry and a share id, where it previously
returned a raw S3 pre-signed URL. It now requires the drive:write scope
instead of drive:read and drive:download, so an API key without write access
can no longer create share links. Code that consumed the returned URL as a
direct object download must follow the share page instead. download_file is
unchanged and still returns a short-lived pre-signed URL.

## [2.0.2](https://github.com/webapper-services/cloudsee-drive-mcp/compare/v2.0.1...v2.0.2) (2026-08-27)


### Bug Fixes

* **update_metadata:** state the 8 GiB ceiling in the tool description ([57b32b7](https://github.com/webapper-services/cloudsee-drive-mcp/commit/57b32b7a67492fd53d0cc79415051e66cb4646a5))

## [2.0.1](https://github.com/webapper-services/cloudsee-drive-mcp/compare/v2.0.0...v2.0.1) (2026-08-11)


### Bug Fixes

* **upload:** check the inline size before allocating the decode buffer ([dcfb71d](https://github.com/webapper-services/cloudsee-drive-mcp/commit/dcfb71d08fc22e2b305e6dbcd573e393cb6d98a6))

# [2.0.0](https://github.com/webapper-services/cloudsee-drive-mcp/compare/v1.0.0...v2.0.0) (2026-08-11)


* feat!: Claude Desktop extension and background large-file uploads ([6c54aaa](https://github.com/webapper-services/cloudsee-drive-mcp/commit/6c54aaaefa1ea38a4d6e8be47f7f48e4e074f87d))


### BREAKING CHANGES

* upload_file no longer accepts a contentType argument — the type is
derived from the file name, because storage signs the upload URL with its own
derivation and any other value produces a signature mismatch.
* over stdio, upload_file no longer completes a file larger than
8 MiB before returning. It returns an upload id; poll upload_status until it
reports completed.
* on the hosted transport, upload_file takes content + encoding
instead of localPath, capped at 256 KB. A hosted server has no access to the
caller's disk.

# 1.0.0 (2026-08-05)


* feat!: report the real package version, and document key rotation and unstable list_files ids ([b7e8de8](https://github.com/webapper-services/cloudsee-drive-mcp/commit/b7e8de875ebc2ba89d5cf896e2e17c46ed9d3871))


### BREAKING CHANGES

* list_buckets calls POST /storage/drives and returns the account's
registered drives, permission-filtered, instead of the bucket inventory that the withdrawn
POST /storage/buckets endpoint returned.

# Changelog

All notable changes to this project are documented here. Going forward this file is managed by
[semantic-release](https://semantic-release.gitbook.io/) from
[Conventional Commits](https://www.conventionalcommits.org/). Entries up to and including 0.1.5
predate automated releasing and are consolidated by hand.

## [Unreleased]

### Added

- **Packaged as a Claude Desktop extension (MCP Bundle).** `npm run build:mcpb` produces a
  `.mcpb` a user installs with one click and configures through a form — no editing
  `claude_desktop_config.json`, no `npx`, no paths. This is the distribution route for anyone
  who needs to upload large local files: the extension runs on the user's own machine, so
  `upload_file` takes a path and streams in parts with no conversation-imposed ceiling.
  - `manifest.json` declares the tools, the `user_config` fields (API key id, secret — marked
    sensitive —, base URL, default drive, log level) and the privacy-policy URL.
  - The bundle inlines `@modelcontextprotocol/sdk` and `zod` into a single ~770 KB file, so no
    `node_modules` ships and nothing can fail to resolve on install.
  - `test/manifest.test.ts` asserts the manifest cannot drift from the code: same tool list,
    same version as the package *and* as the runtime handshake, every env var wired from a
    declared `user_config` key, and the real config loader accepting the exact env the manifest
    produces — including when every optional field is left blank.
- **A "Privacy Policy" section in the README**, required for a directory listing.
- **Multipart upload for files larger than 8 MiB.** `upload_file` now uploads large files in parts
  automatically (8 MiB per part), capturing each part's ETag and finalizing via
  `/storage/upload/complete-parts`. A failed part aborts the multipart upload so no orphaned parts
  remain. Files up to 8 MiB still use the single-shot path.

### Changed

- **`upload_file` now has two shapes, selected by transport — same tool name either way.**
  Over **stdio** it keeps `localPath`: the server runs on the caller's own machine, so reading
  the file there is correct and there is no size limit. On a **hosted** connector a path is
  meaningless (it would resolve against the server's filesystem, which is also an
  arbitrary-file-read vector) and a remote MCP client cannot perform the pre-signed PUT itself
  either — verified against production, which refused it with
  `Host not in allowlist: <bucket>.s3.amazonaws.com`. The hosted shape therefore takes
  `content` + `encoding` (`"utf8"` default, `"base64"` for binary) and this server performs the
  PUT. It is capped at **256 KB**, set by how much a caller can realistically put in one
  request rather than by the transport.
  - `createServer(config, tools)` now takes the tool set; `allTools` (stdio) and `hostedTools`
    hold the same 17 names and differ only in this variant.
  - `contentType` is no longer an input on either shape — see the Fixed entry below.
- **Uploads no longer overwrite.** Both shapes probe the target key first and, if it is taken,
  store the file with a timestamp appended (`report (30-07-2026 14:05).md`), reporting the name
  used — the same rule the web uploader applies.
- **`destinationFolder` is optional**; omitting it means the drive root.
- **Multipart parts upload four at a time** instead of strictly one after another, and the part
  size is now **16 MiB** (was 8 MiB), matching the web uploader. Concurrency does not create
  bandwidth — on a saturated link it changes nothing — but it stops a high-latency link idling
  between round trips. Parts are still finalized in ascending order regardless of the order they
  complete in.
- Note the tracking is in memory: quitting the MCP client cancels an upload in progress, and
  ids do not survive a restart.
- **BREAKING: `rename_file`, `move_file` and `delete_files` are re-grounded on the queue-based
  contract.** The direct `/storage/object/rename`, `/storage/object/move` and
  `/storage/objects/delete` endpoints no longer exist; the tools now post to the queue-backed
  `/storage/object/rename-request`, `/storage/object/move-request` / `/storage/object/copy-request`
  and `/storage/objects/delete-request` rows. These operations are **asynchronous**: the tool
  returns a queue `RequestId` and the operation completes in the background (typically under
  2 minutes) — verify by listing. Input schema changes:
  - `rename_file`: `oldObjectId` is replaced by `objectKey` (the exact key from a listing;
    folders keep their trailing slash), and `storageId` (the `StorageId` from `search_files` /
    `browse_folder` / `recent_files`) is now **required**.
  - `move_file`: `sourcePath` is replaced by `objectKey`, and `storageId` is now **required**.
    A copy (`asCopy=true`) posts to the sibling copy endpoint; `destinationBucket` still
    defaults to the source drive.
  - `delete_files`: `objectKeys: string[]` is replaced by
    `objects: [{ key, isFolder?, storageId }]` (`storageId` required per object). The endpoint
    takes one object per request, so the tool queues them sequentially and reports every
    object's outcome — a failure on one object no longer hides the others' results.
  The operation type and caller identity (`RequestType`, `AsCopy`, `UserId`) are pinned
  server-side per endpoint and are never sent by the tools. Two-step confirmation is unchanged
  (copy remains confirm-free).
- The contract snapshot (`contract/registry.snapshot.json`) is regenerated from the current
  CloudSee Drive public API registry seed: the trimmed GA surface (36 rows) with the three direct
  write rows removed and the four queue-backed rows added.
- **Gated-rollout notes removed from tool descriptions and docs** — the gateway's RBAC/scope
  wiring is live and the full write path is verified end-to-end, so the "the gateway
  may deny this — expected" caveat is gone. Write/delete descriptions now state that a denial
  means the API key lacks the tool's scope (`drive:write` / `drive:delete`). The `list_buckets`
  known-limitation note is corrected: it returns the drives the API key can access, no longer
  an empty list.
- **`list_files`'s per-call id instability is now documented everywhere a user or the model
  might look**: the README (previously silent), the Guide's queued-operations section
  (previously undocumented *why*), and the tool's own description (what the model reads at
  call time).
- **API key rotation now has a documented Troubleshooting entry.** Rotating a key mints a new
  id and secret together and revokes the old id immediately — both `CLOUDSEE_API_KEY_ID` and
  `CLOUDSEE_API_KEY_SECRET` must be updated together after rotating.
- **The destructive-confirmation wording (README + Guide) now describes the actual safety
  mechanism.** It previously implied the server's two-step confirm was the safety boundary; it
  now names Claude Desktop's own tool-permission prompt as the real gate and explains Deny,
  per-call independence, and the "Allow for this task" default.

### Fixed

- **A multipart upload left the file invisible in the drive.** `/storage/upload/complete-parts`
  only assembles the S3 object; it does not create an index entry. So a large upload reported
  success, the bytes were verifiably in the bucket with a correct multipart ETag — and the drive
  showed a folder size with no file in it, while `get_file_metadata` returned null. Registration
  is a second call, `/storage/upload/complete`, which the single-file path already made and the
  web uploader makes for both paths (`StorageContext.completeUploadProcess`). Multipart now makes
  it too, and reports a clear error naming the consequence if that call fails.
- **`summarize()` crashed on a response with no body.** `JSON.stringify(undefined)` returns
  `undefined` rather than throwing, so the existing `try/catch` never fired and the next string
  operation threw — surfacing as an upload marked "failed" with an unhelpful reason.
- **Large uploads no longer fail as a timeout.** An MCP client abandons a tool call after 60
  seconds (`DEFAULT_REQUEST_TIMEOUT_MSEC` in the SDK), and nothing the server sends reliably
  extends that — progress notifications only reset the clock when the client set
  `resetTimeoutOnProgress`, which is false by default. Any file that takes longer than a minute
  to transfer was therefore reported as `-32001 Request timed out`, in some cases while the
  upload was still running and about to succeed. Reported from the field: 6.2 MiB worked,
  51 MiB and 422 MiB did not.
  - A file over 8 MiB now uploads **in the background**. `upload_file` returns an id
    immediately; the new **`upload_status`** tool reports parts done, bytes, percentage, rate
    and ETA, and whether the job is running, completed or failed. The file is in the drive only
    once the job says `completed`.
  - This mirrors what the product already does for `rename_file`, `move_file` and
    `delete_files`, which return a queue id and finish in the background.
  - `upload_status` is stdio-only — the hosted transport uploads inline and synchronously, and a
    stateless Lambda could not report on a background job anyway.
- **Uploads failed with `403 SignatureDoesNotMatch` for most file types.** Storage ignores the
  caller's `contentType`, re-derives one from the file name and signs the pre-signed URL with
  *that*, while returning only the URL — so a client sending `application/octet-stream` could
  never match for any extension in the service's table (`.md`, `.txt`, `.json`, `.pdf`, `.mov`,
  …). The type is now derived from the file name exactly as the service does
  (`src/tools/mime.ts`), used for both the presign and the PUT, and pinned against a committed
  snapshot of the service's table by the contract-drift test.
- **"Local file not found" now points at near matches.** A name differing only by an invisible
  character — a macOS screen recording's `U+202F` before `AM`/`PM`, for instance — produced a
  message that looked identical to the path asked for. The error now lists the close name from
  the same folder and names the character.
- **An oversized file is rejected before any network call**, instead of after the collision
  probe.
- **The reported version is the real one.** `VERSION` was a hand-maintained copy that had
  drifted: the published 0.1.5 tarball announces itself as `0.1.0` in the MCP handshake, the
  User-Agent and `/healthz`. It is now read from `package.json` and inlined at build time, with
  a test binding manifest, package and runtime to the same number.
- **A blank optional setting no longer stops the server from starting.** MCPB (and a Claude
  Desktop `env` block) substitute an unset optional value as an empty string rather than
  omitting the key, which `.url()` and `.min(1)` rejected — so leaving "default drive" empty
  would have failed the very first launch. Blank is now read as absent.
- **`create_folder` matches the real contract.** The endpoint consumes `object` as a
  folder descriptor, so the tool now sends `object: { name }` instead of a bare name string
  (the old shape crashed the handler). The tool's input schema is unchanged.
- **HTTP 403 errors now surface the API's actual denial reason.** The client used to map every
  403 to a generic "Access denied by the API gateway" message, hiding app-level denials such as
  `insufficient_scope` ("Missing required scope(s): drive:write."). The response body is now
  parsed first and the API's error code and message are reported (secret-redacted); the gateway
  wording remains the fallback when no app payload is present.
- **Single-shot upload (≤ 8 MiB) works against the live API.** `/storage/upload/url` returns only
  the presigned URL (no object key), which made `upload_file` refuse to finalize. The key is now
  derived exactly the way the server builds it (destination folder + file name) — matching both
  the presign and finalize paths — with a server-echoed key still preferred when present. The
  destination folder is normalized to a trailing `/` so the server's verbatim concatenation can't
  produce a mangled key.
- **`update_metadata` matches the real contract.** The tool sent `objectKey`, but the endpoint
  requires the **`storageId`** of the object's index entry (the `StorageId` field from
  `search_files` / `browse_folder` / `recent_files` — not `list_files`) and treats the request as
  a full-state SET: metadata is now the structured `{category, description, project}` object and
  `tags` the complete replacement tag set, with the overwrite semantics called out in the tool
  description and confirmation preview. Verified end-to-end against UAT.

## [0.1.5] - 2026-06-23

Consolidated baseline of the first published releases (0.1.0–0.1.5). Patch-level boundaries are not
individually reconstructed — these versions predate semantic-release tagging.

### Added

- Stdio MCP server exposing **17 tools** across read / download / write:
  `list_buckets`, `list_files`, `browse_folder`, `search_files`, `recent_files`, `get_file_metadata`,
  `get_file_tags`, `download_file`, `share_link`, `upload_file`, `create_folder`, `rename_file`,
  `move_file`, `duplicate_file`, `delete_files`, `update_metadata`, `restore_archived_file`.
- `list_files` — recursive whole-drive listing via `/storage/bucket/files`, the reliable lister where
  the search-indexed view (`browse_folder` / `search_files`) can be empty.
- A per-call `bucketName` selector on every drive-scoped tool, plus an optional
  `CLOUDSEE_DEFAULT_BUCKET` fallback (the drive is always taken from input or config, never hardcoded).
- Typed `CloudSeeClient` over the CloudSee Drive `/v1/*` data plane: `X-Api-Key-Id` /
  `X-Api-Key-Secret` auth, envelope unwrapping, retry with backoff + `Retry-After`, and secret-safe
  error handling.
- Opaque, dialect-tagged pagination cursors normalizing the API's `nextPage` / `marker` /
  `lastEvaluatedKey` / `pageToken` / `nextToken` families.
- Two-step confirmation guardrail (`confirm: true`) on destructive tools, with `destructiveHint`
  annotations.
- Tool↔contract drift test gating the build against a committed snapshot of the API surface.
- Optional `debug` request/response audit logging to stderr (secret redacted) via
  `CLOUDSEE_LOG_LEVEL=debug`.
- OSS scaffolding: MIT license, README quickstart + usage GUIDE, contributing/security docs, GitHub
  Actions CI (lint / typecheck / test / build / smoke on macOS/Linux/Windows × Node 18/20), and a
  semantic-release publish workflow.

### Fixed

- `recent_files` pagination: the continuation token (`nextToken`) is read from the response envelope
  (a sibling of `data`), so paging past the first page works; a full-page guard avoids advertising a
  perpetual next page on small datasets.

### Notes

- Write/delete/share tools are present but their end-to-end authorization is **sequenced behind the
  gateway's RBAC wiring**.
- `search_files` is single-folder (non-recursive); use `list_files` for a complete drive listing.
- `list_buckets` currently returns an empty list for public API keys (drive enumeration not yet
  wired) — supply the drive name from the CloudSee dashboard.
