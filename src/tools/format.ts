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

/** Append a continuation hint when the API returned another page. */
export function withCursor(body: string, nextCursor?: string): string {
  if (!nextCursor) return body;
  return `${body}\n\n↪ More results available. Call this tool again with cursor="${nextCursor}" for the next page.`;
}
