// Propagates package.json's version into the two files that also carry it but are
// not managed by semantic-release: manifest.json (what Claude Desktop shows for the
// installed extension) and server.json (the MCP registry listing).
//
// Wired to npm's `version` lifecycle script, which is what makes this automatic:
// @semantic-release/npm bumps the version by running
//   npm version <next> --no-git-tag-version --allow-same-version
// and npm runs the `version` script after writing package.json and before anything
// is committed. .releaserc.json lists both files as @semantic-release/git assets, so
// the release commit carries them. Running `npm version` by hand works the same way.
//
// Without this, every automated release moved package.json alone and left the other
// two behind — which test/manifest.test.ts turns into a red build, by design.
//
// Paths resolve from this file's own location, never from the cwd, for the same
// reason as scripts/package-version.mjs: the caller's cwd is not guaranteed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const serverDir = new URL("../", import.meta.url);

function read(name) {
  const path = fileURLToPath(new URL(name, serverDir));
  try {
    return { path, raw: readFileSync(path, "utf8") };
  } catch (cause) {
    throw new Error(`Cannot read ${path} to sync the version`, { cause });
  }
}

const { raw: pkgRaw } = read("package.json");
const version = JSON.parse(pkgRaw).version;
if (typeof version !== "string" || version.trim().length === 0) {
  throw new Error('package.json has no usable "version" field');
}

// Rewritten as text rather than JSON.parse/stringify so formatting, key order and
// comments-by-convention survive untouched: a reformatted manifest.json would show up
// as noise in the release commit and in every later diff.
const targets = [
  // manifest.json carries exactly one version field, at the top level.
  { file: "manifest.json", expected: 1 },
  // server.json carries two: the server's own version and the npm package's.
  { file: "server.json", expected: 2 },
];

let changed = 0;
for (const { file, expected } of targets) {
  const { path, raw } = read(file);
  let hits = 0;
  const next = raw.replace(/("version"\s*:\s*)"[^"]*"/g, (_match, prefix) => {
    hits += 1;
    return `${prefix}${JSON.stringify(version)}`;
  });

  if (hits !== expected) {
    throw new Error(`${path}: expected ${expected} "version" field(s), found ${hits} — sync-version.mjs needs updating`);
  }

  if (next !== raw) {
    writeFileSync(path, next);
    changed += 1;
    console.log(`[sync-version] ${file} -> ${version}`);
  }
}

if (changed === 0) console.log(`[sync-version] manifest.json and server.json already at ${version}`);
