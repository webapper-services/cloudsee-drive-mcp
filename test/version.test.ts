import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as { version: string };

describe("VERSION", () => {
  it("matches package.json, not a hardcoded string", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is a valid semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
