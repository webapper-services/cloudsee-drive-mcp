# Contributing to CloudSee Drive MCP server

Thanks for your interest! This is an open-source (MIT) wrapper over the CloudSee Drive public
API. Contributions are welcome via pull request.

## Getting started

```bash
git clone https://github.com/webapper-services/cloudsee-drive-mcp.git
cd cloudsee-drive-mcp
npm install
npm test
```

## Development workflow

1. Branch from `main`.
2. Make your change with tests. Keep the build green:
   ```bash
   npm run lint && npm run typecheck && npm test && npm run build
   ```
3. Open a PR to `main`. CI runs lint/typecheck/test/build/smoke on macOS, Linux, and Windows.

## Conventional Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) — `semantic-release`
derives the version and changelog from them. Examples:

- `feat: add favorites tools` → minor release
- `fix: handle empty bucket listing` → patch release
- `feat!: rename X` or a `BREAKING CHANGE:` footer → major release

Reference the related GitHub issue in the body where relevant (e.g. `#123`).

## Adding or changing a tool

Every tool must wrap a **real, reachable data-plane endpoint**. The tool↔contract drift test
(`test/contract/drift.test.ts`) enforces this against `contract/registry.snapshot.json`.

- Add the tool to the appropriate module under `src/tools/` with a Zod input schema, a clear
  description, MCP annotations (`readOnlyHint` / `destructiveHint`), and its backing `endpoint`
  (`{ method, path, scopes }`).
- Route any mutating tool through the two-step confirm helper (`src/confirm.ts`).
- If the upstream API surface changed, refresh the snapshot:
  ```bash
  npm run sync:contract   # reads the CloudSee Drive API registry seed; never executes or edits it
  ```
- Pin scope hints to the API's live scopes (`drive:read` / `drive:download` / `drive:write` /
  `drive:delete`).

## Guardrails

- **Never log, return, or commit the API secret.** All logging goes to **stderr** (stdout is
  the MCP transport). `.env` is gitignored — only `.env.example` (placeholders) is committed.
- Bound tool output (cap/paginate large listings) so it doesn't flood the model context.

## Reporting security issues

See [`SECURITY.md`](SECURITY.md). Do not open a public issue for vulnerabilities.
