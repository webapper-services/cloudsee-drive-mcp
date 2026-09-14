// Output bounding so large listings never flood the model context (R8 / AC).
// Arrays are capped, deeply, and the whole rendering is hard-capped by length.

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_CHARS = 8_000;

export function summarize(data: unknown, opts: { maxItems?: number; maxChars?: number } = {}): string {
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  let json: string;
  try {
    // JSON.stringify RETURNS undefined for undefined (and for a function or symbol) rather than
    // throwing, so the catch below never fires and every later string operation would blow up
    // on it. An endpoint that answers with no body is a normal thing to render.
    json = JSON.stringify(boundArrays(data, maxItems), null, 2) ?? String(data);
  } catch {
    json = String(data);
  }
  if (json.length > maxChars) {
    json = `${json.slice(0, maxChars)}\n… (output truncated at ${maxChars} characters — narrow your query or paginate).`;
  }
  return json;
}

/**
 * Render a listing envelope so the fields that describe the result set survive the
 * size cap. `summarize` caps the rendered TEXT, and a listing serializes `totalItems`
 * / `totalPages` AFTER `items`, so a character cut destroys exactly the numbers that
 * would reveal the truncation (CSD-662 / F2). Here the items are dropped instead and
 * the envelope's scalars are rendered first, alongside how many items are shown.
 * A payload with no `items` array is not a listing and falls through to `summarize`.
 */
export function summarizeListing(data: unknown, opts: { maxItems?: number; maxChars?: number } = {}): string {
  const items = listingItems(data);
  if (!items) return summarize(data, opts);
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const envelope = data as Record<string, unknown>;

  let shown = Math.min(items.length, maxItems);
  let json = renderListing(envelope, items, shown, maxItems);
  while (json.length > maxChars && shown > 0) {
    shown = Math.floor(shown / 2);
    json = renderListing(envelope, items, shown, maxItems);
  }
  // The scalars alone can still overrun the cap (an unusually large field); the
  // caller's context must be bounded either way, so fall back to the text cut.
  if (json.length > maxChars) {
    json = `${json.slice(0, maxChars)}\n… (output truncated at ${maxChars} characters — narrow your query or paginate).`;
  }
  return json;
}

/** The `items` array of a listing envelope, or undefined when `data` is not one. */
function listingItems(data: unknown): unknown[] | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const items = (data as Record<string, unknown>).items;
  return Array.isArray(items) ? items : undefined;
}

function renderListing(envelope: Record<string, unknown>, items: unknown[], shown: number, maxItems: number): string {
  const view: Record<string, unknown> = {};
  // Scalars first (totalItems, totalPages, …) so they are never the truncated tail.
  for (const [key, value] of Object.entries(envelope)) {
    if (key === "items") continue;
    if (value !== null && typeof value === "object") continue;
    view[key] = value;
  }
  view.shown = shown;
  const rendered: unknown[] = items.slice(0, shown).map((item) => boundArrays(item, maxItems));
  if (shown < items.length) {
    rendered.push(`… ${items.length - shown} more item(s) omitted to fit the output budget — paginate for the rest.`);
  }
  view.items = rendered;
  try {
    return JSON.stringify(view, null, 2);
  } catch {
    return String(view);
  }
}

function boundArrays(value: unknown, maxItems: number): unknown {
  if (Array.isArray(value)) {
    const capped: unknown[] = value.slice(0, maxItems).map((v) => boundArrays(v, maxItems));
    if (value.length > maxItems) {
      capped.push(`… ${value.length - maxItems} more item(s) omitted — paginate for the rest.`);
    }
    return capped;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = boundArrays(v, maxItems);
    }
    return out;
  }
  return value;
}

/**
 * Render what `update_metadata` actually did, from the outcome object the
 * metadata endpoint returns (CSD-664). A model that just called a destructive
 * tool has to be told which fields and tags survived — the old response was the
 * bare update count, which said nothing.
 *
 * A backend that predates CSD-664 (or one rolled back to it) answers with that
 * integer instead, so anything that is not the outcome object falls back to the
 * previous text. Deploy-order skew must not turn into a crash or a lie.
 */
export function formatMetadataUpdate(data: unknown, storageId: string): string {
  const outcome = readMetadataOutcome(data);
  if (!outcome) return `Updated metadata on storage id "${storageId}".\n\n${summarize(data)}`;
  const modeNote =
    outcome.mode === "merge" ? "anything you did not send was kept" : "everything you did not send was cleared";
  return (
    `Updated metadata on storage id "${storageId}" (mode: ${outcome.mode} — ${modeNote}).\n` +
    `Metadata — changed: ${nameList(outcome.metadata.changed)}; cleared: ${nameList(outcome.metadata.cleared)}; ` +
    `kept: ${nameList(outcome.metadata.kept)}.\n` +
    `Tags — set: ${nameList(outcome.tags.set)}; kept: ${nameList(outcome.tags.kept)}; ` +
    `removed: ${nameList(outcome.tags.removed)}. ${outcome.tags.total} tag(s) now on the object.`
  );
}

type MetadataOutcome = {
  mode: "merge" | "replace";
  metadata: { changed: string[]; cleared: string[]; kept: string[] };
  tags: { set: string[]; removed: string[]; kept: string[]; total: number };
};

function nameList(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "none";
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

/** The §2.5 outcome object, or undefined for any other payload (including the legacy integer). */
function readMetadataOutcome(data: unknown): MetadataOutcome | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.mode !== "merge" && record.mode !== "replace") return undefined;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const tags = record.tags as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== "object" || !tags || typeof tags !== "object") return undefined;
  const changed = stringArray(metadata.changed);
  const cleared = stringArray(metadata.cleared);
  const keptFields = stringArray(metadata.kept);
  const set = stringArray(tags.set);
  const removed = stringArray(tags.removed);
  const keptTags = stringArray(tags.kept);
  if (!changed || !cleared || !keptFields || !set || !removed || !keptTags || typeof tags.total !== "number") {
    return undefined;
  }
  return {
    mode: record.mode,
    metadata: { changed, cleared, kept: keptFields },
    tags: { set, removed, kept: keptTags, total: tags.total },
  };
}

/** Append a continuation hint when the API returned another page. */
export function withCursor(body: string, nextCursor?: string): string {
  if (!nextCursor) return body;
  return `${body}\n\n↪ More results available. Call this tool again with cursor="${nextCursor}" for the next page.`;
}
