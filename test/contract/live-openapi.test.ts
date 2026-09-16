import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CSD-668 C-06: every other contract assertion runs tools → snapshot, so nothing checks the
// snapshot against a deployed environment. This suite is the only one that does — and it needs
// the network, so it is OPT-IN and skipped by default. Run it deliberately, at release time:
//
//   CLOUDSEE_CONTRACT_LIVE_BASE_URL=https://drive-api.cloudsee.cloud npm test
//
// The snapshot is pinned to the PRODUCTION surface. Against UAT this suite reports
// `POST /storage/buckets` as missing, which is correct and expected: that row is retired on UAT
// and still served on production for its CSD-625 deprecation window.
const LIVE_BASE_URL = process.env.CLOUDSEE_CONTRACT_LIVE_BASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(resolve(here, "../../contract/registry.snapshot.json"), "utf8")) as {
  endpoints: Array<{ method: string; path: string }>;
};

// Served by drive-bridge as a static path entry with no registry row (CSD-639), so it is in the
// live document and can never be in a seed-derived snapshot. Exact matches only.
const STATICALLY_DOCUMENTED = ["POST /auth/verify"];
const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);
const FETCH_TIMEOUT_MS = 30_000;

type OpenApiDocument = { openapi?: unknown; paths?: Record<string, Record<string, unknown>> };

/** "METHOD /path" for every operation the live document publishes. */
function endpointsFromOpenApi(doc: OpenApiDocument): string[] {
  const endpoints: string[] = [];
  for (const [apiPath, operations] of Object.entries(doc.paths ?? {})) {
    if (!operations || typeof operations !== "object") continue;
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.has(method.toLowerCase())) endpoints.push(`${method.toUpperCase()} ${apiPath}`);
    }
  }
  return endpoints;
}

async function fetchLiveDocument(baseUrl: string): Promise<OpenApiDocument> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/openapi.json`;
  // A User-Agent is mandatory: the API's WAF answers 403 to requests without one.
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "cloudsee-drive-mcp-contract-check" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  const doc = (await response.json()) as OpenApiDocument;
  // A fallback document published after a failed registry fetch would otherwise read as
  // "zero drift" (CSD-584 R5), so an unusable document has to fail loudly instead.
  if (!doc || doc.openapi == null) throw new Error(`${url} is not an OpenAPI document (no \`openapi\` field)`);
  const live = endpointsFromOpenApi(doc);
  if (live.length === 0) throw new Error(`${url} publishes no paths — likely the empty/fallback document`);
  return doc;
}

describe.runIf(LIVE_BASE_URL)("committed contract ↔ live /v1/openapi.json (opt-in)", () => {
  let live: string[] = [];

  beforeAll(async () => {
    live = endpointsFromOpenApi(await fetchLiveDocument(LIVE_BASE_URL as string));
  }, FETCH_TIMEOUT_MS + 5_000);

  it("publishes every endpoint the committed snapshot advertises", () => {
    const committed = snapshot.endpoints.map((e) => `${e.method} ${e.path}`);
    const missing = committed.filter((endpoint) => !live.includes(endpoint));

    expect(missing, `advertised by the snapshot but NOT served by ${LIVE_BASE_URL}`).toEqual([]);
  });

  it("publishes nothing the committed snapshot omits", () => {
    const committed = new Set(snapshot.endpoints.map((e) => `${e.method} ${e.path}`));
    const extra = live.filter((endpoint) => !committed.has(endpoint) && !STATICALLY_DOCUMENTED.includes(endpoint));

    expect(extra, `served by ${LIVE_BASE_URL} but absent from the snapshot`).toEqual([]);
  });

  it("still serves the statically documented endpoints that carry no seed row", () => {
    const absent = STATICALLY_DOCUMENTED.filter((endpoint) => !live.includes(endpoint));

    expect(absent, `statically documented but NOT served by ${LIVE_BASE_URL}`).toEqual([]);
  });
});
