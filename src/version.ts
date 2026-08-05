// Single source of truth for the package version, surfaced to the MCP client
// handshake, the health check, and the User-Agent. Read from package.json at
// process start — not hardcoded, not a static import (tsconfig.json's
// rootDir: "src" excludes ../package.json from the compiled program) — so it
// can never drift from what was actually published again.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// package.json sits one directory above this file for every entry point
// EXCEPT the Lambda deploy bundle (infra/build/lambda/lambda.mjs), which ships
// as a single self-contained file with no npm package around it —
// infra/deploy.ps1 copies package.json next to it, so it resolves
// same-directory there. Tried in this order; extend the list rather than
// touching the six call sites if a future entry point needs a third layout.
const CANDIDATE_PATHS = ["../package.json", "./package.json"];

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of CANDIDATE_PATHS) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, candidate), "utf8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`Could not resolve package.json next to ${here} (checked: ${CANDIDATE_PATHS.join(", ")})`);
}

export const VERSION = readPackageVersion();
