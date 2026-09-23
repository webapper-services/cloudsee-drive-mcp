import { AuthError, CloudSeeError } from "../errors";
import { textResult, type ToolResult } from "./types";

/**
 * CSD-586 Bug A (A2). A key a listing tool just returned can reach a path-addressed tool with
 * an invisible character replaced — the reported case is a macOS screenshot whose time
 * separator is U+202F NARROW NO-BREAK SPACE arriving as a plain U+0020. S3 and the index both
 * match keys byte-exactly (measured on UAT: the exact key HEADs 200, the U+0020 variant 404),
 * so the object is unreachable by the only spelling the caller has. This module asks the index
 * for the folder's own spelling of that name and retries ONCE with it.
 *
 * It is deliberately silent when it cannot resolve: on zero or several candidates the caller
 * sees exactly the outcome it sees today, and nothing about the candidates reaches the
 * response. CSD-638 requires absence and access-denial to answer alike, so a message that
 * varied with the content of a key would re-open the existence oracle that ceiling closes.
 */

/**
 * The information ceiling CSD-638 set for an object the caller cannot be shown: absence and
 * access denial answer with the SAME sentence, so the pair cannot be used to probe for objects
 * in accounts the credential cannot reach.
 *
 * Until CSD-670 this was copied verbatim from the server's own wording (storage-api
 * PublicApiErrorClassifier), deliberately, so both halves of a round trip read alike. It
 * diverges now: leading with the credential sent the reporter hunting a permission fault when
 * the real cause was an invisible character in the key, and by the time the connector answers
 * this it has already asked the index for another spelling — advice the server cannot give.
 * The replacement is still ONE fixed sentence, identical for absence and denial, and still says
 * nothing about the key it was given, so the ceiling is untouched; only the advice changed. The
 * tools that post a key without this recovery still surface the server's older wording raw, and
 * that divergence is accepted (CSD-670 D2).
 *
 * It lives here because every tool that resolves a caller-supplied object key answers it for a
 * key the recovery below could not resolve, and one sentence means one definition.
 */
export const OBJECT_NOT_AVAILABLE =
  "Could not resolve this object key. Either no object with this key exists, or your credential cannot read it. " +
  "Copy the key exactly as a listing tool returned it — a file name can carry invisible characters that must be " +
  "sent byte-for-byte.";

/** The one answer a key that could not be resolved produces, in every tool that takes a key. */
export function objectNotAvailableResult(): ToolResult {
  const result = textResult(OBJECT_NOT_AVAILABLE);
  result.isError = true;
  return result;
}

/** The one call this module makes — narrower than CloudSeeClient, so the recovery path depends
 *  on the endpoint it uses rather than on the whole client. */
export interface IndexedListingClient {
  post<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T>;
}

/**
 * A name reduced to the form two spellings of "the same name" share: NFKC first (it folds
 * U+202F and the other compatibility spaces onto U+0020), then whitespace runs collapsed and
 * case dropped. JS `\s` covers the Unicode space separators — U+00A0 and U+202F included —
 * which is exactly the class that makes two names look identical without matching.
 */
export function foldForMatching(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
}

/**
 * How many indexed items the resolution lookup asks for. The lookup lists the key's own folder
 * whole, so this has to cover that folder's direct children: a page that comes back full is
 * treated as inconclusive below, which makes a folder wider than this lose the recovery. 200 is
 * the connector's own listing ceiling (`MAX_PAGE_ITEMS` in read.ts), not a new bound.
 */
const RESOLUTION_PAGE_SIZE = 200;

/** The parent prefix of an object key, keeping its trailing slash the way the index stores
 *  `Parent`. A key with no slash sits at the drive root, which the server reads as "". */
function parentPrefix(objectKey: string): string {
  const lastSlash = objectKey.lastIndexOf("/");
  return lastSlash === -1 ? "" : objectKey.slice(0, lastSlash + 1);
}

/** The items of a `/storage/list` answer: an envelope's `items`, or a bare array. (format.ts
 *  keeps its own copy of this private, and the recovery path must not depend on the renderer.) */
function listedItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const items = (data as Record<string, unknown>).items;
    if (Array.isArray(items)) return items;
  }
  return [];
}

/** An indexed item's full key — `Key`, or `Path` where the index reports it under that name,
 *  the same pair the listing renderer projects. */
function itemKey(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const key = (item as Record<string, unknown>).Key ?? (item as Record<string, unknown>).Path;
  return typeof key === "string" && key ? key : undefined;
}

/**
 * The drive's own spelling of `objectKey`, when the index holds exactly ONE name that folds to
 * it and that name is not the spelling already tried. `undefined` — no candidate, more than
 * one, a page that may have been cut, or a failed lookup — means "do not retry", and is the
 * answer that keeps the CSD-638 ceiling intact.
 *
 * The lookup asks for the key's own folder and NOTHING else: no `searchingKeyword`. A keyword
 * can only be built from the spelling the caller typed, and the server matches it as a
 * byte-exact substring of the whole indexed `Name` — so for the very case this recovery exists
 * for, the keyword is the broken spelling and matches nothing (CSD-586, measured on production
 * 2026-09-17). Fetching the folder leaves every judgement to `foldForMatching`, which makes no
 * assumption about which character was substituted.
 */
export async function resolveIndexedKey(
  client: IndexedListingClient,
  bucketName: string,
  objectKey: string,
): Promise<string | undefined> {
  // A trailing slash names a folder. Every listed key of that folder is a child, so none of them
  // can fold onto it, and the lookup could only spend a call to find that out.
  if (objectKey.endsWith("/")) return undefined;

  let data: unknown;
  try {
    data = await client.post("/storage/list", {
      bucketName,
      dirPath: parentPrefix(objectKey),
      pageSize: RESOLUTION_PAGE_SIZE,
    });
  } catch {
    // The recovery is an extra attempt, never a new failure mode: its own failure is the
    // caller's original outcome, unchanged.
    return undefined;
  }

  const items = listedItems(data);
  // A full page may have cut a second candidate off the end, and "exactly one" would then be a
  // property of the page size rather than of the drive.
  if (items.length >= RESOLUTION_PAGE_SIZE) return undefined;

  const wanted = foldForMatching(objectKey);
  const candidates = new Set(
    items
      .map(itemKey)
      .filter((key): key is string => key !== undefined && foldForMatching(key) === wanted),
  );
  if (candidates.size !== 1) return undefined;
  const [only] = [...candidates];
  return only === objectKey ? undefined : only;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function attempt<T>(call: (key: string) => Promise<T>, key: string): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await call(key) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Is a failure one that a different spelling of the key could fix — and therefore one the
 * ceiling sentence may stand in for?
 *
 * This is the DEFAULT policy every caller gets, not the only one. A tool may narrow it by passing
 * its own predicate to `callWithKeyRecovery` (CSD-670): all three exclusions below are
 * transport-level, and `swaggerProxyResponse` serves EVERY storage-api application failure —
 * validation, permission, conflict, unclassified fault — as HTTP 200, so the `status >= 500` arm
 * can never fire for one and each of them is read here as a key miss. A tool whose endpoint can
 * report its own failures distinguishably supplies a predicate that keeps them; the rest keep
 * this one unchanged.
 *
 * Three classes are excluded, because answering them with "object not available" would hide a
 * fault that has nothing to do with the key:
 *  - a rejected credential is not a spelling problem, and the index lookup would be denied too;
 *  - a retryable transport failure may already have reached the server and been acted on —
 *    `share_link` creates a record — so a second call under another key could duplicate a write
 *    the caller never saw succeed;
 *  - a server-side fault (5xx) is the server failing, not the object being absent.
 */
function worthResolving(error: unknown): boolean {
  if (error instanceof AuthError) return false;
  if (!(error instanceof CloudSeeError)) return true;
  return !error.retryable && !(error.status !== undefined && error.status >= 500);
}

/** The result of a key-addressed call: the payload, or the fact that no spelling of the key
 *  reached an object — which every caller answers with `objectNotAvailableResult()`. */
export type KeyedOutcome<T> = { resolved: true; value: T } | { resolved: false };

/**
 * Run a key-addressed call and, when it comes back a miss, retry it ONCE with the exact key the
 * drive holds for that name.
 *
 * `isMiss` covers the endpoints that answer for an object they cannot resolve with an empty
 * payload instead of an error (`/storage/object/detail`); a thrown failure `isKeyMiss` accepts is
 * a miss by definition. A miss that the retry does not clear is reported as `{ resolved: false }`
 * — never as the server's own wording, which varies with the key and would tell an absent object
 * apart from an unreadable one. Anything `isKeyMiss` rejects is re-thrown untouched: it is a real
 * failure and must surface as itself.
 *
 * `isKeyMiss` defaults to `worthResolving`, so a caller that does not pass one behaves exactly as
 * it did before. A tool whose endpoint refuses requests for reasons of its own passes a narrower
 * one rather than the shared default being edited for that endpoint (CSD-670).
 */
export async function callWithKeyRecovery<T>(
  client: IndexedListingClient,
  bucketName: string,
  objectKey: string,
  call: (key: string) => Promise<T>,
  isMiss: (value: T) => boolean = () => false,
  isKeyMiss: (error: unknown) => boolean = worthResolving,
): Promise<KeyedOutcome<T>> {
  const first = await attempt(call, objectKey);
  if (first.ok && !isMiss(first.value)) return { resolved: true, value: first.value };
  if (!first.ok && !isKeyMiss(first.error)) throw first.error;

  const exactKey = await resolveIndexedKey(client, bucketName, objectKey);
  if (exactKey !== undefined) {
    const retry = await attempt(call, exactKey);
    if (retry.ok && !isMiss(retry.value)) return { resolved: true, value: retry.value };
  }

  return { resolved: false };
}
