# Changelog

All notable changes to this project are documented here. Going forward this file is managed by
[semantic-release](https://semantic-release.gitbook.io/) from
[Conventional Commits](https://www.conventionalcommits.org/). Entries up to and including 0.1.5
predate automated releasing and are consolidated by hand.

## [Unreleased]

### Changed

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

### Added

- **Multipart upload for files larger than 8 MiB.** `upload_file` now uploads large files in parts
  automatically (8 MiB per part), capturing each part's ETag and finalizing via
  `/storage/upload/complete-parts`. A failed part aborts the multipart upload so no orphaned parts
  remain. Files up to 8 MiB still use the single-shot path.

### Fixed

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
- **The advertised server version no longer drifts from `package.json`.** `VERSION` was
  hardcoded to `0.1.0` in `src/version.ts` and never updated by anything; it is now read from
  `package.json` at process start, so the MCP handshake, the health check, and the
  `User-Agent` string always report the version that was actually published.

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
