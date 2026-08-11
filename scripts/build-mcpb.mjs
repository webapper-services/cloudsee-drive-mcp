#!/usr/bin/env node
/**
 * Assemble the MCPB desktop-extension bundle.
 *
 *   npm run build:mcpb        → build/mcpb/  staged, then packed to build/cloudsee-drive.mcpb
 *
 * Layout inside the archive (see MANIFEST.md in modelcontextprotocol/mcpb):
 *
 *   manifest.json
 *   server/index.js     ← self-contained ESM bundle, deps inlined by tsup.mcpb.config.ts
 *   icon.png            ← only when present next to this package
 *
 * No node_modules ships: tsup inlines @modelcontextprotocol/sdk and zod, which keeps the
 * archive small and removes any chance of a dependency failing to resolve on a user's machine.
 *
 * Packing needs the MCPB CLI (`npm i -g @anthropic-ai/mcpb`). Without it the staged directory
 * is still produced and the exact command to finish the job is printed, so this script is
 * useful — and CI-safe — even where the CLI is absent.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const stage = resolve(root, "build", "mcpb");
const entry = resolve(stage, "server", "index.js");
const manifestSrc = resolve(root, "manifest.json");
const manifestOut = resolve(stage, "manifest.json");

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// The bundle must already be built — `npm run build:mcpb` runs tsup first.
if (!existsSync(entry)) {
  fail(`Missing ${entry}\n  Run: npx tsup --config tsup.mcpb.config.ts`);
}

const manifest = JSON.parse(readFileSync(manifestSrc, "utf8"));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// A bundle whose version disagrees with the package it was built from is a support problem
// nobody can debug from the outside, so make it impossible to ship one.
if (manifest.version !== pkg.version) {
  fail(`manifest.json version (${manifest.version}) != package.json version (${pkg.version}).\n  Update manifest.json before packing.`);
}

writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// The manifest declares the icon, so a missing file is a broken bundle, not a warning: it would
// pack and install with no artwork and nothing would say why.
if (manifest.icon) {
  const src = resolve(root, manifest.icon);
  if (!existsSync(src)) fail(`manifest.json declares icon "${manifest.icon}" but ${src} does not exist.`);
  copyFileSync(src, resolve(stage, manifest.icon));
  console.log(`Included ${manifest.icon}`);
} else {
  // console.log, not console.warn: on Windows PowerShell anything a native command writes to
  // stderr is rendered as a red ErrorRecord, making a successful build look like a failure.
  console.log("! manifest.json declares no icon - a directory listing needs one.");
}

const sizeKb = Math.round(statSync(entry).size / 1024);
console.log(`Staged ${stage}`);
console.log(`  manifest.json`);
console.log(`  server/index.js  (${sizeKb} KB, dependencies inlined)`);

const outFile = resolve(root, "build", `${manifest.name}-${manifest.version}.mcpb`);
rmSync(outFile, { force: true });

// Prefer a globally installed CLI; fall back to npx so a fresh clone and CI both work with no
// setup step. `mcpb pack` also validates the manifest against the published schema, which is
// the only check that the manifest is actually well-formed — worth not skipping.
const win = process.platform === "win32";
const attempts = [
  { cmd: "mcpb", args: ["pack", stage, outFile] },
  { cmd: "npx", args: ["--yes", "@anthropic-ai/mcpb", "pack", stage, outFile] },
];

let packed = false;
for (const { cmd, args } of attempts) {
  try {
    execFileSync(cmd, args, { stdio: "inherit", shell: win });
    packed = true;
    break;
  } catch {
    /* try the next one */
  }
}

if (packed) {
  console.log(`\n✔ ${outFile}`);
} else {
  console.log(
    `\nStaged, but not packed — could not run the MCPB CLI (no global install, and npx failed).\n` +
      `  npm i -g @anthropic-ai/mcpb\n` +
      `  mcpb pack "${stage}" "${outFile}"`,
  );
}
