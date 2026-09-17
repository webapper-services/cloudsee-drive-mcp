import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import { foldForMatching } from "../../src/tools/keyResolution";
import { AuthError, CloudSeeError } from "../../src/errors";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";
import type { ToolDef, ToolResult } from "../../src/tools/types";

// CSD-586 Bug A (A2). A key a listing tool just returned reaches a path-addressed tool with an
// invisible character replaced — the reported case is a macOS screenshot whose time separator is
// U+202F NARROW NO-BREAK SPACE arriving as a plain U+0020. S3 and the index match keys
// byte-exactly (measured on UAT: the exact key HEADs 200, the U+0020 variant 404), so the file is
// unreachable by the only spelling the caller has. The recovery asks the index for the folder's
// own spelling of that name and retries ONCE with it.
//
// The other half of this file is the ceiling CSD-638 set: when the key cannot be resolved, the
// caller must see the same sentence an object it may not read would produce. A message that
// varied with the content of a key would make the pair an existence oracle.

/** Verbatim from storage-api's PublicApiErrorClassifier — the one sentence all three
 *  path-addressed tools answer for a key they cannot resolve. */
const OBJECT_NOT_AVAILABLE = "The specified object does not exist or is not available to your credential.";

const NARROW_NO_BREAK_SPACE = " ";
const NO_BREAK_SPACE = " ";

const FOLDER = "App-Verify-2026-09-15/";
const BASENAME = "Screenshot 2026-09-15 at 2.38.21";
/** What the drive actually holds — the spelling Daniela's `browse_folder` returned. */
const DRIVE_KEY = `${FOLDER}${BASENAME}${NARROW_NO_BREAK_SPACE}PM.png`;
/** What arrives at the tool once the narrow space has been flattened to a plain one. */
const TYPED_KEY = `${FOLDER}${BASENAME} PM.png`;
/** A second spelling that folds onto the same name — the "two candidates" case. */
const RIVAL_KEY = `${FOLDER}${BASENAME}${NO_BREAK_SPACE}PM.png`;

const DETAIL = "/storage/object/detail";
const DOWNLOAD_URL = "/storage/object/download-url";
const SHARE_CREATE = "/shares/link/create";
const LIST = "/storage/list";

/** The page size the resolution lookup asks for; a page that comes back this full is ambiguous. */
const RESOLUTION_PAGE_SIZE = 50;

/** One message, used at a 5xx and at a 404, so the two cases differ ONLY in the status. */
const SERVER_FAULT = "CloudSee API error for /storage/object/download-url: Internal server error";

const byName = Object.fromEntries(allTools.map((tool) => [tool.name, tool]));
const getFileMetadata = byName["get_file_metadata"]!;
const downloadFile = byName["download_file"]!;
const shareLink = byName["share_link"]!;

interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
}

/** Answers one endpoint. `attempt` counts from 0 per path, so a route can miss then resolve. */
type Route = (body: Record<string, unknown>, attempt: number) => unknown;

interface Harness {
  ctx: { client: CloudSeeClient };
  callsTo(path: string): RecordedCall[];
}

/**
 * A client that records every outbound call and answers per endpoint. An endpoint with no route
 * is a test bug rather than a miss, so it fails loudly instead of quietly looking like an
 * absent object.
 */
function harness(routes: Record<string, Route>): Harness {
  const calls: RecordedCall[] = [];
  const post = vi.fn(async (path: string, body: Record<string, unknown> = {}) => {
    const attempt = calls.filter((call) => call.path === path).length;
    calls.push({ path, body });
    const route = routes[path];
    if (!route) throw new Error(`No stub route for ${path}`);
    return route(body, attempt);
  });
  return {
    ctx: { client: { post, postPaged: vi.fn() } as unknown as CloudSeeClient },
    callsTo: (path) => calls.filter((call) => call.path === path),
  };
}

/** One indexed item under the given key, shaped the way `/storage/list` answers. */
function indexedItem(key: string): Record<string, unknown> {
  return { Key: key, Name: key.slice(key.lastIndexOf("/") + 1), Size: 34, StorageId: "os-1" };
}

/** A page of `size` items in which exactly one folds to the wanted name. */
function pageContainingTheDriveKey(size: number): Array<Record<string, unknown>> {
  const filler = Array.from({ length: size - 1 }, (_unused, index) => indexedItem(`${FOLDER}other-${index}.png`));
  return [indexedItem(DRIVE_KEY), ...filler];
}

interface Outcome {
  text: string;
  isError: boolean;
}

/**
 * What the caller ends up seeing. `createServer` turns a thrown handler error into an `isError`
 * text result, so a throw and an `isError` result are the same outcome from a conversation's
 * point of view — collapsing them here asserts the wording without excusing either shape.
 */
async function outcomeOf(tool: ToolDef, args: Record<string, unknown>, ctx: { client: CloudSeeClient }): Promise<Outcome> {
  try {
    const result: ToolResult = await tool.handler(args, ctx);
    return { text: result.content[0]?.text ?? "", isError: result.isError === true };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

interface ToolProbe {
  name: string;
  tool: ToolDef;
  /** The endpoint the tool addresses the key with. */
  path: string;
  args: Record<string, unknown>;
  /** How that endpoint reports a miss: a throw for most, an empty payload for the detail route. */
  miss: Route;
  /** What the endpoint answers once it is given the key the drive actually holds. */
  hit: Route;
  /** A fragment of that answer, so "it succeeded" is decidable from the rendered text. */
  hitMarker: string;
}

const probes: ToolProbe[] = [
  {
    name: "get_file_metadata",
    tool: getFileMetadata,
    path: DETAIL,
    args: { bucketName: "cloudsee-demo", objectKey: TYPED_KEY },
    // /storage/object/detail answers success:true, data:null for an object it cannot resolve —
    // two frames inside storage-api swallow the miss — so "it came back ok" is not "it resolved".
    miss: () => null,
    hit: () => ({ ...indexedItem(DRIVE_KEY), ContentType: "image/png" }),
    hitMarker: "image/png",
  },
  {
    name: "download_file",
    tool: downloadFile,
    path: DOWNLOAD_URL,
    args: { bucketName: "cloudsee-demo", filePath: TYPED_KEY },
    miss: () => {
      throw new CloudSeeError("File doesn't exist on S3.", { status: 404, code: "not_found" });
    },
    hit: () => ({ url: "https://s3.example/get?sig=1" }),
    hitMarker: "https://s3.example/get?sig=1",
  },
  {
    name: "share_link",
    tool: shareLink,
    path: SHARE_CREATE,
    args: { bucketName: "cloudsee-demo", filePath: TYPED_KEY },
    miss: () => {
      throw new CloudSeeError("File doesn't exist.", { status: 404, code: "not_found" });
    },
    hit: () => ({ shareableLink: "https://drive.cloudsee.cloud/share/2f9c1d7e", shareId: "2f9c1d7e" }),
    hitMarker: "https://drive.cloudsee.cloud/share/2f9c1d7e",
  },
];

/** The key each tool put on the wire on its Nth attempt — the field name differs per endpoint. */
function sentKey(call: RecordedCall): unknown {
  return call.path === DETAIL ? call.body.objectKey : call.body.filePath;
}

const downloadProbe = probes.find((probe) => probe.name === "download_file")!;
const shareProbe = probes.find((probe) => probe.name === "share_link")!;

describe("A2 — a key whose invisible character did not survive the trip is retried once", () => {
  it.each(probes)("$name retries with the byte-exact key the index holds, and succeeds", async (probe) => {
    const h = harness({
      [probe.path]: (body, attempt) => (attempt === 0 ? probe.miss(body, attempt) : probe.hit(body, attempt)),
      [LIST]: () => ({ items: [indexedItem(DRIVE_KEY)] }),
    });

    const result = await probe.tool.handler(probe.args, h.ctx);

    const attempts = h.callsTo(probe.path);
    expect(attempts).toHaveLength(2);
    expect(sentKey(attempts[1]!)).toBe(DRIVE_KEY);
    // Byte-exact, not merely "looks the same": the narrow space is what S3 matches on.
    expect(String(sentKey(attempts[1]!))).toContain(NARROW_NO_BREAK_SPACE);
    expect(h.callsTo(LIST)).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(probe.hitMarker);
  });

  it.each(probes)("$name retries EXACTLY once — a second miss is not resolved again", async (probe) => {
    const h = harness({
      [probe.path]: probe.miss,
      [LIST]: () => ({ items: [indexedItem(DRIVE_KEY)] }),
    });

    await outcomeOf(probe.tool, probe.args, h.ctx);

    expect(h.callsTo(probe.path)).toHaveLength(2);
    expect(h.callsTo(LIST)).toHaveLength(1);
  });

  it.each(probes)("$name leaves a call that succeeded first time alone — no lookup, no retry", async (probe) => {
    const h = harness({
      [probe.path]: probe.hit,
      [LIST]: () => ({ items: [indexedItem(DRIVE_KEY)] }),
    });

    const result = await probe.tool.handler(probe.args, h.ctx);

    expect(h.callsTo(probe.path)).toHaveLength(1);
    expect(h.callsTo(LIST)).toHaveLength(0);
    expect(result.isError).toBeUndefined();
  });
});

describe("A2 — an unresolvable key answers the CSD-638 ceiling sentence, from every tool", () => {
  const unresolvable: Array<{ because: string; list: Route }> = [
    { because: "the index holds no candidate", list: () => ({ items: [] }) },
    {
      because: "two indexed keys fold to the same name",
      list: () => ({ items: [indexedItem(DRIVE_KEY), indexedItem(RIVAL_KEY)] }),
    },
    {
      because: "the page came back full and may have been cut",
      list: () => ({ items: pageContainingTheDriveKey(RESOLUTION_PAGE_SIZE) }),
    },
    {
      because: "the index lookup itself failed",
      list: () => {
        throw new CloudSeeError("index unavailable", { status: 503, code: "upstream" });
      },
    },
  ];

  const cases = unresolvable.flatMap((reason) => probes.map((probe) => ({ ...probe, ...reason })));

  it.each(cases)("$name answers the ceiling sentence when $because", async (testCase) => {
    const h = harness({ [testCase.path]: testCase.miss, [LIST]: testCase.list });

    const outcome = await outcomeOf(testCase.tool, testCase.args, h.ctx);

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe(OBJECT_NOT_AVAILABLE);
  });

  // share_link creates a Shares record and publishes the file to anyone holding the link. A
  // second create under another spelling is a second live share the caller never asked for.
  it("share_link issues exactly ONE create when the key cannot be resolved — a duplicate share is real harm", async () => {
    const h = harness({ [SHARE_CREATE]: shareProbe.miss, [LIST]: () => ({ items: [] }) });

    await outcomeOf(shareProbe.tool, shareProbe.args, h.ctx);

    expect(h.callsTo(SHARE_CREATE)).toHaveLength(1);
  });

  it("download_file issues exactly ONE request when the key cannot be resolved", async () => {
    const h = harness({ [DOWNLOAD_URL]: downloadProbe.miss, [LIST]: () => ({ items: [] }) });

    await outcomeOf(downloadProbe.tool, downloadProbe.args, h.ctx);

    expect(h.callsTo(DOWNLOAD_URL)).toHaveLength(1);
  });

  // The ceiling is the point: the answer may not carry anything that distinguishes "absent" from
  // "you may not read it", and it may not describe the key the caller asked about.
  it.each(probes)("$name names no candidate, describes no key and lists no codepoints", async (probe) => {
    const h = harness({
      [probe.path]: probe.miss,
      [LIST]: () => ({ items: [indexedItem(DRIVE_KEY), indexedItem(RIVAL_KEY)] }),
    });

    const { text } = await outcomeOf(probe.tool, probe.args, h.ctx);

    expect(text).not.toContain(NARROW_NO_BREAK_SPACE);
    expect(text).not.toContain(NO_BREAK_SPACE);
    expect(text).not.toContain(BASENAME);
    expect(text).not.toContain(FOLDER);
    expect(text).not.toMatch(/U\+[0-9a-f]{4}/i);
    expect(text).not.toMatch(/narrow|no-break|codepoint|did you mean/i);
  });
});

describe("A2 — failures a different spelling could not fix are never resolved", () => {
  // A rejected credential is not a spelling problem, and the index lookup would be denied too.
  it.each(probes)("$name does not look up the index after an auth failure", async (probe) => {
    const h = harness({
      [probe.path]: () => {
        throw new AuthError("API key rejected (HTTP 401).", { status: 401 });
      },
      [LIST]: () => ({ items: [indexedItem(DRIVE_KEY)] }),
    });

    const { isError } = await outcomeOf(probe.tool, probe.args, h.ctx);

    expect(isError).toBe(true);
    expect(h.callsTo(LIST)).toHaveLength(0);
    expect(h.callsTo(probe.path)).toHaveLength(1);
  });

  // A retryable transport failure may have reached the server and been acted on. share_link
  // writes, so a second call under another key could duplicate a share the caller never saw.
  it.each(probes)("$name does not look up the index after a retryable transport failure", async (probe) => {
    const h = harness({
      [probe.path]: () => {
        throw new CloudSeeError("Request timed out after 30000ms.", { code: "timeout", retryable: true });
      },
      [LIST]: () => ({ items: [indexedItem(DRIVE_KEY)] }),
    });

    const { isError } = await outcomeOf(probe.tool, probe.args, h.ctx);

    expect(isError).toBe(true);
    expect(h.callsTo(LIST)).toHaveLength(0);
    expect(h.callsTo(probe.path)).toHaveLength(1);
  });

  // A 5xx that reaches a tool has already survived the client's own internal retries and arrives
  // with `retryable: false` (CloudSeeClient throws it from the !response.ok branch), so the guard
  // above does not cover it. The server being broken is not the object being absent, and
  // answering it with the ceiling sentence would hide a live outage behind "not found".
  it.each(probes)("$name surfaces a server-side fault unchanged, and does not look up the index", async (probe) => {
    const h = harness({
      [probe.path]: () => {
        throw new CloudSeeError(SERVER_FAULT, { status: 503, code: "http_error" });
      },
      [LIST]: () => ({ items: [indexedItem(DRIVE_KEY)] }),
    });

    const { text, isError } = await outcomeOf(probe.tool, probe.args, h.ctx);

    expect(isError).toBe(true);
    expect(text).toBe(SERVER_FAULT);
    expect(text).not.toBe(OBJECT_NOT_AVAILABLE);
    expect(h.callsTo(LIST)).toHaveLength(0);
    expect(h.callsTo(probe.path)).toHaveLength(1);
  });

  // The same failure at a 4xx IS a spelling candidate. Without this the assertion above would
  // still hold if key recovery had been removed altogether, or if every error were refused —
  // it is what makes the guard discriminate on the status rather than on having failed at all.
  it.each(probes)("$name still enters recovery for a 404 carrying that same message", async (probe) => {
    const h = harness({
      [probe.path]: () => {
        throw new CloudSeeError(SERVER_FAULT, { status: 404, code: "http_error" });
      },
      [LIST]: () => ({ items: [indexedItem(DRIVE_KEY)] }),
    });

    await outcomeOf(probe.tool, probe.args, h.ctx);

    expect(h.callsTo(LIST)).toHaveLength(1);
    expect(h.callsTo(probe.path)).toHaveLength(2);
  });
});

describe("A2 — the shape of the resolution lookup", () => {
  it("asks the key's own folder for the name, with the non-ASCII run collapsed into the keyword", async () => {
    const h = harness({ [DOWNLOAD_URL]: downloadProbe.miss, [LIST]: () => ({ items: [] }) });

    await outcomeOf(downloadProbe.tool, downloadProbe.args, h.ctx);

    const [lookup] = h.callsTo(LIST);
    expect(lookup!.body.bucketName).toBe("cloudsee-demo");
    expect(lookup!.body.dirPath).toBe(FOLDER);
    expect(lookup!.body.searchingKeyword).toBe(`${BASENAME} PM.png`);
    // A keyword carrying the very character that did not survive would search for a spelling the
    // caller could not have produced.
    expect(String(lookup!.body.searchingKeyword)).toMatch(/^[\x20-\x7E]*$/);
    expect(lookup!.body.pageSize).toBe(RESOLUTION_PAGE_SIZE);
  });

  it("asks about the drive root for a key that carries no folder at all", async () => {
    const rootTyped = `${BASENAME} PM.png`;
    const rootExact = `${BASENAME}${NARROW_NO_BREAK_SPACE}PM.png`;
    const h = harness({
      [DOWNLOAD_URL]: (body, attempt) => (attempt === 0 ? downloadProbe.miss(body, attempt) : { url: "https://s3.example/get" }),
      [LIST]: () => ({ items: [indexedItem(rootExact)] }),
    });

    await downloadProbe.tool.handler({ bucketName: "cloudsee-demo", filePath: rootTyped }, h.ctx);

    expect(h.callsTo(LIST)[0]!.body.dirPath).toBe("");
    expect(sentKey(h.callsTo(DOWNLOAD_URL)[1]!)).toBe(rootExact);
  });

  // A trailing slash names a folder: there is no basename to search the index for, so there is
  // nothing to resolve and no reason to spend a call finding that out.
  it("never looks up a key that names a folder", async () => {
    const h = harness({ [DOWNLOAD_URL]: downloadProbe.miss, [LIST]: () => ({ items: [] }) });

    await outcomeOf(downloadProbe.tool, { bucketName: "cloudsee-demo", filePath: FOLDER }, h.ctx);

    expect(h.callsTo(LIST)).toHaveLength(0);
    expect(h.callsTo(DOWNLOAD_URL)).toHaveLength(1);
  });

  // /storage/bucket/files and /storage/recent answer with a bare array; the renderer already had
  // to learn that (CSD-667 defect 3) and the recovery path must not assume an envelope either.
  it.each([
    { shape: "a bare array", list: (): unknown => [indexedItem(DRIVE_KEY)] },
    { shape: "an item carrying only Path", list: (): unknown => ({ items: [{ Path: DRIVE_KEY, Name: "Screenshot.png" }] }) },
  ])("resolves from $shape", async ({ list }) => {
    const h = harness({
      [DOWNLOAD_URL]: (body, attempt) => (attempt === 0 ? downloadProbe.miss(body, attempt) : { url: "https://s3.example/get" }),
      [LIST]: list,
    });

    await downloadProbe.tool.handler(downloadProbe.args, h.ctx);

    expect(sentKey(h.callsTo(DOWNLOAD_URL)[1]!)).toBe(DRIVE_KEY);
  });

  it("ignores an entry whose key is absent, is not a string, or is not an object at all", async () => {
    const h = harness({
      [DOWNLOAD_URL]: downloadProbe.miss,
      [LIST]: () => ({ items: [{ Name: "no key here" }, { Key: 42 }, null, "not an object", { Key: "" }] }),
    });

    const { isError } = await outcomeOf(downloadProbe.tool, downloadProbe.args, h.ctx);

    expect(isError).toBe(true);
    expect(h.callsTo(DOWNLOAD_URL)).toHaveLength(1);
  });

  // A page that came back full may have cut a second candidate off the end, which would make
  // "exactly one match" a property of the page size rather than of the drive. One item short of
  // full carries the same data without the ambiguity — so the guard is a bound, not a refusal.
  it("resolves from a page one item short of full, but never from a full one", async () => {
    function harnessForPage(size: number): Harness {
      return harness({
        [DOWNLOAD_URL]: (body, attempt) =>
          attempt === 0 ? downloadProbe.miss(body, attempt) : { url: "https://s3.example/get" },
        [LIST]: () => ({ items: pageContainingTheDriveKey(size) }),
      });
    }

    const short = harnessForPage(RESOLUTION_PAGE_SIZE - 1);
    await outcomeOf(downloadProbe.tool, downloadProbe.args, short.ctx);
    expect(short.callsTo(DOWNLOAD_URL)).toHaveLength(2);

    const full = harnessForPage(RESOLUTION_PAGE_SIZE);
    await outcomeOf(downloadProbe.tool, downloadProbe.args, full.ctx);
    expect(full.callsTo(DOWNLOAD_URL)).toHaveLength(1);
  });

  // The whole point is a DIFFERENT spelling. Re-sending the one that just missed would spend a
  // call — and for share_link a write — to reach the identical answer.
  it("does not retry when the index offers back the very spelling that already missed", async () => {
    const h = harness({ [DOWNLOAD_URL]: downloadProbe.miss, [LIST]: () => ({ items: [indexedItem(TYPED_KEY)] }) });

    await outcomeOf(downloadProbe.tool, downloadProbe.args, h.ctx);

    expect(h.callsTo(DOWNLOAD_URL)).toHaveLength(1);
  });
});

// The same fold backs write.ts's near-match hint for a local file, so a name that resolves on the
// drive side is reported as a near match on the local side.
describe("foldForMatching", () => {
  it.each([
    { label: "U+202F NARROW NO-BREAK SPACE", space: NARROW_NO_BREAK_SPACE },
    { label: "U+00A0 NO-BREAK SPACE", space: NO_BREAK_SPACE },
  ])("folds $label onto a plain space", ({ space }) => {
    expect(foldForMatching(`Screenshot at 2.38${space}PM.png`)).toBe(foldForMatching("Screenshot at 2.38 PM.png"));
  });

  it("collapses runs of whitespace and drops case", () => {
    expect(foldForMatching("  Annual   REPORT.PDF ")).toBe(foldForMatching(" annual report.pdf  "));
  });

  it("keeps genuinely different names apart", () => {
    expect(foldForMatching("report-2025.pdf")).not.toBe(foldForMatching("report-2026.pdf"));
  });

  it("leaves a name that needs no folding untouched, apart from case", () => {
    expect(foldForMatching("docs/a.txt")).toBe("docs/a.txt");
  });
});
