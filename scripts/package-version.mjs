// Single source of truth for the version injected into every bundle as
// __MCP_SERVER_VERSION__ (see src/version.ts for the list of configs that must
// declare the define).
//
// Resolved from this file's own location, never from the cwd: the three configs
// that import it live in two different directories (server/ and infra/) and tsup
// is always invoked from server/, so a cwd-relative path would silently read the
// wrong file — or none at all.
//
// A missing or malformed version throws here, which fails the BUILD. That is the
// point of CSD-628: the lookup used to happen at Lambda load time, where the same
// failure crashed init and returned 502 on every request instead.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

function readPackageVersion() {
  let raw;
  try {
    raw = readFileSync(packageJsonPath, "utf8");
  } catch (cause) {
    throw new Error(`Cannot read ${packageJsonPath} to resolve the MCP server version`, { cause });
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${packageJsonPath} is not valid JSON`, { cause });
  }

  const version = manifest?.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`${packageJsonPath} has no usable "version" field`);
  }
  return version;
}

export const packageVersion = readPackageVersion();
