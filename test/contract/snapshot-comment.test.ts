import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CSD-586 (F2, Branch R): the live OpenAPI document publishes 33 data-plane endpoints while this
// snapshot holds 32, because `POST /auth/verify` carries no registry row and the generator's only
// source is the seed. That is deliberate, and `live-openapi.test.ts` already allow-lists it — but
// the count kept being re-raised as a defect by anyone counting endpoints. Branch R's deliverable
// is therefore this forward pin, not a red-then-green test: it was never red for a real defect,
// and its whole job is to fail the day the explanation disappears.
//
// It asserts the explanation in BOTH places, because the snapshot is generated: dropping it from
// the generator's literal and re-running `npm run sync:contract` would otherwise erase it silently.

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(resolve(here, "../../contract/registry.snapshot.json"), "utf8")) as {
  $comment: string;
  endpointCount: number;
  endpoints: Array<{ method: string; path: string }>;
};
const generatorSource = readFileSync(resolve(here, "../../scripts/sync-contract.mjs"), "utf8");

describe("contract snapshot ↔ the /auth/verify exclusion (CSD-586)", () => {
  it("the snapshot's $comment names the excluded endpoint and why it cannot be generated", () => {
    expect(snapshot.$comment).toContain("POST /auth/verify");
    expect(snapshot.$comment).toContain("no registry row");
    expect(snapshot.$comment).toContain("published statically");
  });

  it("the generator carries the same explanation, so regenerating cannot drop it", () => {
    expect(generatorSource).toContain("POST /auth/verify");
    expect(generatorSource).toContain("no registry row");
    expect(generatorSource).toContain("published statically");
  });

  it("the endpoint the comment explains is indeed absent, and the count matches the list", () => {
    const paths = snapshot.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).not.toContain("POST /auth/verify");
    expect(snapshot.endpointCount).toBe(snapshot.endpoints.length);
  });
});
