// Output bounding so large listings never flood the model context (R8 / AC).
// Arrays are capped, deeply, and the rendering is bounded by length — for a listing by
// abbreviating items rather than dropping them, since a dropped item is unreachable (CSD-667).

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_CHARS = 8_000;

/**
 * How many items the FIRST call of a walk asks for — a seed, not a universal truth. It is the
 * only page size chosen without evidence: no page has been rendered yet, so there is nothing to
 * measure and the connector has to guess. Every later call uses `recommendedPageSize`, measured
 * on the caller's own data (CSD-667 C6).
 *
 * Calibrated on INTERNAL data, which is exactly why it cannot be trusted as a general bound:
 * rendered cost of one projected item, at names of 12/25/40/55/70/85 characters under a nested
 * path and carrying the Project and Category metadata a drive in use fills in, is
 * 423/449/479/509/539/569 characters, for which the largest page that renders whole is
 * 18/17/16/15/14/13. 13 is the largest seed that holds across that whole range — at an
 * 85-character name under a 125-character key a page of 13 costs 7 518 of the 8 000-character
 * budget beside the `/storage/list` envelope, the same measurement `ENVELOPE_BUDGET_SHARE` cites,
 * and a 14th item drops the page to stubs.
 *
 * A customer's items can be heavier than anything measured here: `Project`, `Category` and
 * `Description` are user-entered and unbounded, and folder trees go deeper than ours. That is
 * what the adaptive loop is for. The previous value of 20 was derived from 12-character names
 * (`surf-000.jpg`), and on any drive with descriptive or nested names the DEFAULT call returned
 * identity-only stubs and no cursor at all — a guess presented as a measurement.
 */
export const FIRST_PAGE_ITEMS = 13;

/**
 * How many items the NEXT call should ask for, measured from the page just rendered. The mean
 * cost of a projected item on THIS page is the only evidence about the caller's data that the
 * connector ever gets, so the walk converges on it: heavy items shrink the page, light ones
 * grow it, and neither depends on how close the drive is to the one this file was measured on.
 *
 * Cost is taken from the items IN FULL — what the page would have cost at L1 — never from what
 * an abbreviated render happened to produce: a page of stubs is cheap precisely because it is
 * the outcome to avoid, and reading its length back would recommend repeating it.
 *
 * The divisor is the share of the budget the items are guaranteed (`ENVELOPE_BUDGET_SHARE` caps
 * the rest), so the estimate errs low — a slightly short page renders whole, one item too many
 * costs the whole page its detail. `undefined` for a payload that is not a listing, or an empty
 * page: neither carries evidence, and the caller then keeps whatever it is already using.
 */
export function recommendedPageSize(data: unknown, opts: { maxItems?: number; maxChars?: number } = {}): number | undefined {
  const items = listingItems(data);
  if (!items || items.length === 0) return undefined;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const total = items.reduce<number>((sum, item) => sum + entryCost(listingItemView(item, maxItems)), 0);
  const perItem = total / items.length;
  if (!Number.isFinite(perItem) || perItem <= 0) return undefined;
  return Math.max(1, Math.floor((maxChars * (1 - ENVELOPE_BUDGET_SHARE)) / perItem));
}

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

/** Marker on an item published as identity only (CSD-667 §4.4). Fixed, never interpolated,
 *  so the model reads the same instruction every time and a test can assert it literally. */
export const ABBREVIATED_ITEM_NOTICE =
  "Item too large to render in full — identity only. Call get_file_metadata with this Key for the complete record.";

/** Tail of the L3 sentinel. "Same cursor" is the load-bearing phrase: it tells the caller it has
 *  not lost its place, so re-asking with a smaller page size resumes at the identical position. */
export const SMALLER_PAGE_RETRY_NOTICE =
  "could not be rendered within the output budget. Call this tool again with the same cursor and a smaller pageSize.";

/**
 * How much of one envelope scalar a listing render may spend. The envelope exists to DESCRIBE the
 * result set (`totalItems`, `totalPages`, …); a value longer than this is not a description but a
 * payload, and one such value is enough to consume the whole budget — driven through the real
 * tools, a single oversized scalar left a page with no item entry, no cursor and JSON that does
 * not parse (CSD-667). The bound is deliberately general: it holds for any scalar of any envelope
 * from any endpoint, so it does not rest on a claim about which fields a particular caller
 * produces or which of them that endpoint happens to echo back. 200 characters keeps every
 * descriptive value these endpoints actually carry (a count, a flag, a folder path, a sort
 * option) intact, while holding the whole envelope far below one item's share of the budget.
 */
const MAX_SCALAR_VALUE_CHARS = 200;

/** Marker on an envelope scalar that was cut. A silent truncation is the defect this ticket
 *  exists to remove, so the cut is stated where it happens (CSD-667). */
export const TRUNCATED_SCALAR_NOTICE = `… (value truncated at ${MAX_SCALAR_VALUE_CHARS} characters)`;

/**
 * How long an envelope KEY may be. A scalar's VALUE was bounded; the key it is written under is
 * just as much server-shaped and was not — measured before this bound existed, one 40 000-character
 * key name rendered 40 538 characters against an 8 000-character budget, five times over, with
 * every item still to come (CSD-667). That figure records the defect, not what this file does now.
 * 60 characters holds every field name these endpoints send; longer is not a name.
 */
const MAX_SCALAR_KEY_CHARS = 60;

/** Marker on an envelope KEY that was cut, for the same reason as `TRUNCATED_SCALAR_NOTICE`:
 *  nothing in this module shortens anything silently (CSD-667). */
export const TRUNCATED_KEY_NOTICE = `… (key truncated at ${MAX_SCALAR_KEY_CHARS} characters)`;

/**
 * The share of the render budget the whole envelope may spend. Bounding each scalar does not bound
 * the envelope: measured before this cap existed, 200 bounded scalars still rendered 51 219
 * characters, and from the 32nd the ladder had no item left to give back and broke the budget
 * outright (CSD-667) — again the defect on record, not current behaviour. The split is one eighth —
 * 1 000 characters of the default 8 000 — and it is a CAP, not a reservation: what the envelope
 * does not take stays with the items, which is why a first page of `FIRST_PAGE_ITEMS` projected
 * items still fits at the heaviest weight measured: 7 400 characters of items beside the 118 a
 * `/storage/list` page spends on everything that is not an item entry (`totalItems`, `totalPages`,
 * `shown`, `folderSize`, `query`), 7 518 of the 8 000-character budget. So a description can never
 * crowd out the result set it describes. A share rather than an absolute, so a smaller
 * caller-supplied budget is split the same way instead of being handed whole to the envelope.
 */
const ENVELOPE_BUDGET_SHARE = 1 / 8;

/**
 * The payload fields that let a caller DETECT it is not seeing everything. They are rendered first
 * and are exempt from the envelope budget: they are numbers, they cost ~20 characters each, and
 * dropping one re-creates CSD-662 F2 — a partial page that reads like a complete listing.
 * `shown`, `totalReturned` and `abbreviated` are computed here and are rendered on the same terms.
 */
const TRUNCATION_SIGNAL_FIELDS = ["totalItems", "totalPages"] as const;

/** Names this renderer writes itself. A payload field of the same name would be overwritten by the
 *  connector's own value, so it is never copied in from the envelope. */
const RENDERER_OWNED_FIELDS = new Set(["items", "shown", "totalReturned", "abbreviated", "droppedFields"]);

export interface ListingRender {
  text: string;
  /** Every item on this server page is represented in `text` — in full or as an identity-only
   *  stub. It is the ONLY permission to forward the server's cursor: a cursor emitted over an
   *  unrendered item skips it on the next call, and no later call can reach it (CSD-667 §2). */
  complete: boolean;
}

/**
 * Render a listing envelope so the fields that describe the result set survive the
 * size cap. `summarize` caps the rendered TEXT, and a listing serializes `totalItems`
 * / `totalPages` AFTER `items`, so a character cut destroys exactly the numbers that
 * would reveal the truncation (CSD-662 / F2). Here the envelope's scalars are rendered
 * first, alongside how many items are shown.
 *
 * Items are never silently dropped (CSD-667). The page is rendered at the first level
 * that fits: every item in full (L1); the items that fit in full plus the rest as
 * identity-only stubs, each in its original position (L2); or — when not even all-stubs
 * fits — the longest prefix that does, never fewer than one item, reported incomplete so
 * the caller's cursor is withheld (L3).
 *
 * A payload with no `items` array and which is not itself an array is not a listing and
 * falls through to `summarize`.
 */
export function summarizeListing(data: unknown, opts: { maxItems?: number; maxChars?: number } = {}): ListingRender {
  const items = listingItems(data);
  // Not a listing: there are no items to lose, so forwarding a cursor cannot skip one.
  if (!items) return { text: summarize(data, opts), complete: true };
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  // A bare array carries no envelope. Passing it AS the envelope would turn its numeric
  // indices into scalar keys, so the count travels in `totalReturned` instead (CSD-667 §4.2).
  const bareArray = Array.isArray(data);
  const envelope = bareArray ? {} : (data as Record<string, unknown>);
  return renderPage(envelope, items, maxItems, maxChars, bareArray ? items.length : undefined);
}

/** The items of a listing payload: the `items` array of an envelope, or the payload itself
 *  when the endpoint answers with a bare array (`/storage/bucket/files`, `/storage/recent`). */
function listingItems(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return undefined;
  const items = (data as Record<string, unknown>).items;
  return Array.isArray(items) ? items : undefined;
}

/** The two forms one item can be published in. `stub` is absent when the item carries no
 *  identity to publish — abbreviating it would erase its existence, which nothing recovers. */
interface ItemForms {
  full: unknown;
  stub?: Record<string, unknown>;
}

/** The L1/L2/L3 selection of CSD-667 §4.1. */
function renderPage(
  envelope: Record<string, unknown>,
  items: unknown[],
  maxItems: number,
  maxChars: number,
  totalReturned: number | undefined,
): ListingRender {
  const forms: ItemForms[] = items.map((item) => ({
    full: listingItemView(item, maxItems),
    stub: abbreviatedView(item),
  }));

  const whole = renderListing(envelope, forms, forms.map(() => false), { maxChars, totalReturned });
  if (whole.length <= maxChars) return { text: whole, complete: true };

  const filled = fillPage(envelope, forms, maxChars, totalReturned);
  if (filled) return { text: filled, complete: true };

  return renderLongestPrefix(envelope, forms, maxChars, totalReturned);
}

/** Rendered entries sit two levels deep in the envelope, so every line of an entry carries four
 *  more spaces than a standalone render of it, and entries are joined by ",\n". */
const ENTRY_INDENT_CHARS = 4;
const ENTRY_SEPARATOR_CHARS = 2;

/** What one entry costs inside the rendered `items` array. An estimate — the render-and-verify
 *  pass in `fillPage` is what makes the budget hard. */
function entryCost(view: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(view, null, 2) ?? "null";
  } catch {
    json = String(view);
  }
  return json.length + json.split("\n").length * ENTRY_INDENT_CHARS + ENTRY_SEPARATOR_CHARS;
}

/**
 * L2 — the whole page, with the items that do not fit published as identity-only stubs.
 * Returns undefined when even the cheapest complete rendering overruns the budget (L3).
 */
function fillPage(
  envelope: Record<string, unknown>,
  forms: ItemForms[],
  maxChars: number,
  totalReturned: number | undefined,
): string | undefined {
  const fullCost = forms.map((form) => entryCost(form.full));
  const stubCost = forms.map((form) => (form.stub ? entryCost(form.stub) : Number.POSITIVE_INFINITY));

  // A stub is NOT always shorter than the item it replaces: it carries a fixed ~110-character
  // marker a lean item does not, so stubbing a {Name, Key, Size} item makes it LONGER. The
  // cheapest complete representation therefore takes the cheaper form PER ITEM — and because
  // the cost is not monotonic in "how many items are full", a binary search over that parameter
  // picks a worse level than this ordered accumulate does (CSD-667 §4.1).
  const asStub = forms.map((_, index) => stubCost[index]! < fullCost[index]!);
  let used = forms.reduce(
    (total, _, index) => total + (asStub[index] ? stubCost[index]! : fullCost[index]!),
    renderListing(envelope, [], [], { maxChars, totalReturned }).length,
  );
  if (used > maxChars) return undefined;

  // Spend what is left upgrading stubs back to full, in page order, so the items a caller reads
  // first are the ones it gets whole.
  forms.forEach((_, index) => {
    if (!asStub[index]) return;
    const upgraded = used - stubCost[index]! + fullCost[index]!;
    if (upgraded > maxChars) return;
    asStub[index] = false;
    used = upgraded;
  });

  // The costs above are estimates; the rendered string is the truth. Hand back the last item
  // that is cheaper as a stub until it fits, or drop to L3 when nothing is left to give back.
  let text = renderListing(envelope, forms, asStub, { maxChars, totalReturned });
  while (text.length > maxChars) {
    const giveBack = forms.reduce(
      (last, _, index) => (!asStub[index] && stubCost[index]! < fullCost[index]! ? index : last),
      -1,
    );
    if (giveBack < 0) return undefined;
    asStub[giveBack] = true;
    text = renderListing(envelope, forms, asStub, { maxChars, totalReturned });
  }
  return text;
}

/**
 * L3 — not even all-stubs fits. Render the longest prefix that does and say how many items
 * were left, so the caller can re-ask at the same cursor with a smaller page size.
 *
 * The first item is rendered even when its stub alone overruns the budget: the budget is a
 * soft cap for the first item of a page and a hard cap for every other one. Without that rule
 * `pageSize: 1` renders nothing, the caller is told to shrink a page size that is already 1,
 * and every item behind the offending one is unreachable for good (CSD-667 §4.3).
 */
function renderLongestPrefix(
  envelope: Record<string, unknown>,
  forms: ItemForms[],
  maxChars: number,
  totalReturned: number | undefined,
): ListingRender {
  // The always-render-one rule, clamped to what the page actually holds. An EMPTY page renders
  // completely at 0 items; asking for one anyway reported it incomplete, which withheld the cursor
  // over an item that does not exist — and with nothing left behind there is no sentinel either,
  // so the caller got no cursor AND no instruction while the server still had pages (CSD-667).
  let take = Math.min(1, forms.length);
  let text = renderPrefix(envelope, forms, take, maxChars, totalReturned);
  while (take < forms.length) {
    const grown = renderPrefix(envelope, forms, take + 1, maxChars, totalReturned);
    if (grown.length > maxChars) break;
    take += 1;
    text = grown;
  }
  // What this render guarantees, in full: it is JSON the caller can parse — no character cut, at
  // any size — it carries every item counted in `shown`, and it exceeds `maxChars` only by the
  // first item of the page, whose entry is rendered whole however large it is (§4.3). The envelope
  // cannot cause that overrun: each key and each value is bounded, and the envelope as a whole is
  // capped at `ENVELOPE_BUDGET_SHARE` of the budget with whatever did not fit counted in
  // `droppedFields`. Cutting the text instead is what produced a dead end — 0 of 20 identities, no
  // cursor, unparseable JSON — while 40 items were still behind it (CSD-667). A bounded overrun
  // caused by one item is strictly better than that.
  // `take` never exceeds the page, so the test below is "no item left behind", and it answers yes
  // for a page of none as readily as for a page of forty.
  return { text, complete: take >= forms.length };
}

function renderPrefix(
  envelope: Record<string, unknown>,
  forms: ItemForms[],
  take: number,
  maxChars: number,
  totalReturned: number | undefined,
): string {
  const prefix = forms.slice(0, take);
  const left = forms.length - take;
  return renderListing(envelope, prefix, prefix.map((form) => form.stub !== undefined), {
    maxChars,
    totalReturned,
    sentinel: left > 0 ? `… ${left} item(s) ${SMALLER_PAGE_RETRY_NOTICE}` : undefined,
  });
}

function renderListing(
  envelope: Record<string, unknown>,
  forms: ItemForms[],
  asStub: boolean[],
  opts: { maxChars: number; totalReturned?: number; sentinel?: string },
): string {
  const rendered: unknown[] = forms.map((form, index) => (asStub[index] && form.stub ? form.stub : form.full));
  const abbreviated = forms.filter((form, index) => asStub[index] && form.stub).length;

  const view: Record<string, unknown> = {};
  // The fields that reveal a truncation come first and unconditionally — they are what lets a
  // caller know it is not seeing everything, and they cost a handful of characters each.
  for (const field of TRUNCATION_SIGNAL_FIELDS) {
    const value = envelope[field];
    if (value === undefined || (value !== null && typeof value === "object")) continue;
    view[field] = boundScalar(value);
  }
  view.shown = rendered.length;
  if (opts.totalReturned !== undefined) view.totalReturned = opts.totalReturned;
  // Omitted entirely when nothing was abbreviated, so a clean page reads as it always has.
  // Present whenever it is not: a silent abbreviation is the original defect at a smaller scale.
  if (abbreviated > 0) view.abbreviated = abbreviated;

  const dropped = addDescriptiveScalars(view, envelope, Math.floor(opts.maxChars * ENVELOPE_BUDGET_SHARE));
  // Reported for the same reason as `abbreviated`: what the render leaves out, it says out loud.
  if (dropped > 0) view.droppedFields = dropped;

  view.items = opts.sentinel ? [...rendered, opts.sentinel] : rendered;
  try {
    return JSON.stringify(view, null, 2);
  } catch {
    return String(view);
  }
}

/**
 * The rest of the envelope — the fields that describe the result set without being able to reveal
 * a truncation — written into the view in payload order for as long as the budget lasts. Returns
 * how many did not fit, so the render can state the loss instead of taking it silently (CSD-667).
 */
function addDescriptiveScalars(
  view: Record<string, unknown>,
  envelope: Record<string, unknown>,
  budget: number,
): number {
  let spent = Object.entries(view).reduce((total, [key, value]) => total + scalarEntryCost(key, value), 0);
  let dropped = 0;
  for (const [key, value] of Object.entries(envelope)) {
    if (RENDERER_OWNED_FIELDS.has(key) || key in view) continue;
    // A nested object is not a description of the result set, and rendering one costs items.
    // Deliberately NOT counted in `dropped`: `droppedFields` reports what the BUDGET could not
    // carry, while this skip is a shape rule that applies at any budget. The one production field
    // it hides is `/storage/list`'s array-valued `nextPage`, whose value still reaches the caller
    // through `withCursor`, so nothing is lost — and counting it would put `droppedFields` on
    // every ordinary page, telling the model a clean listing is lossy (CSD-667). Left as is.
    if (value !== null && typeof value === "object") continue;
    const boundedKey = boundKey(key);
    const boundedValue = boundScalar(value);
    const cost = scalarEntryCost(boundedKey, boundedValue);
    // Two long keys can bound to the same string, and the second would then erase the first —
    // a field lost without a trace, which is the one thing this renderer may never do.
    if (boundedKey in view || spent + cost > budget) {
      dropped += 1;
      continue;
    }
    view[boundedKey] = boundedValue;
    spent += cost;
  }
  return dropped;
}

/** `  "key": value,\n` — the indentation, the key's quotes, ": ", the comma and the newline.
 *  Exact rather than an estimate: an envelope entry is a scalar and renders on one line. */
const SCALAR_ENTRY_OVERHEAD_CHARS = 8;

function scalarEntryCost(key: string, value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    json = "null";
  }
  return key.length + json.length + SCALAR_ENTRY_OVERHEAD_CHARS;
}

/** One envelope key as it is published: a field name, or a visibly cut prefix of whatever arrived
 *  claiming to be one. Cut for the same reason as an oversized value, and never silently. */
function boundKey(key: string): string {
  if (key.length <= MAX_SCALAR_KEY_CHARS) return key;
  return `${key.slice(0, MAX_SCALAR_KEY_CHARS)}${TRUNCATED_KEY_NOTICE}`;
}

/**
 * One envelope scalar as it is published. Numbers, booleans and null describe the result set in a
 * handful of characters and pass through whole; a long string does not, and is cut VISIBLY —
 * an unmarked cut here would be the very defect this renderer exists to remove. Nothing else in
 * the envelope is identity, so this is the one place a listing render may shorten a value.
 */
function boundScalar(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= MAX_SCALAR_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_SCALAR_VALUE_CHARS)}${TRUNCATED_SCALAR_NOTICE}`;
}

/** Kept unconditionally, after `Name` and `Key`. */
const LISTING_ITEM_FIELDS = ["Size", "LastModified", "IsFolder", "StorageId", "StorageClass", "Status"] as const;

/** Kept only when they carry something — an index writes most of these back empty. */
const LISTING_ITEM_OPTIONAL_FIELDS = ["Project", "Category", "Description", "RestoreStatus"] as const;

/**
 * One listing item as it is published in full: the fields a caller reads a listing FOR.
 * A raw index document is ~2 300 characters, of which the indexer's own bookkeeping
 * (`Metadata`, `ETag`, `ParentPaths`, `SanitizedKey`, `ObjectUUID`, …) is the bulk; projected
 * it is ~291. No connector code reads any of the dropped fields, and `get_file_metadata`
 * returns the complete record for any one object.
 *
 * `StorageClass`, `Status` and a non-empty `RestoreStatus` are kept deliberately: dropping them
 * would force a `get_file_metadata` call per file to decide whether a file is downloadable or a
 * rename has landed — strictly worse for the budget this projection exists to protect.
 *
 * Used only by `summarizeListing`. `summarize` renders its payloads in full, unchanged.
 */
function listingItemView(item: unknown, maxItems: number): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return boundArrays(item, maxItems);
  const record = item as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  if (record.Name !== undefined) view.Name = record.Name;
  const key = record.Key ?? record.Path;
  if (key !== undefined) view.Key = key;
  for (const field of LISTING_ITEM_FIELDS) {
    // CSD-672: `/storage/recent` rows carry their recency timestamp as `UpdatedAt` and have no
    // `LastModified` of their own; one timestamp name across the four listing tools is the
    // contract. `LastModified` wins where both exist — an indexed document's `UpdatedAt` is the
    // index write time, which stays dropped.
    const value = field === "LastModified" ? (record.LastModified ?? record.UpdatedAt) : record[field];
    if (value !== undefined) view[field] = value;
  }
  for (const field of LISTING_ITEM_OPTIONAL_FIELDS) {
    const value = record[field];
    if (value !== undefined && value !== null && value !== "") view[field] = value;
  }
  return boundArrays(view, maxItems);
}

/**
 * Identity only, for an item that cannot be published in full. Detail is recoverable by a
 * named follow-up call (`get_file_metadata`); existence is recoverable by nothing, because a
 * caller cannot ask for a key it was never told about (CSD-667 §4.2).
 *
 * `Name` and `Key` are rendered whole at any length — a truncated key cannot be passed to
 * `get_file_metadata`, which would put the detail back out of reach. Nothing else is carried:
 * a stub must not be defeated by the very field that made the item heavy. `StorageId` is
 * omitted when the payload has none — on `list_files` it is regenerated per call and that
 * tool's own description forbids using it for writes, so `Key` is the identity there.
 */
function abbreviatedView(item: unknown): Record<string, unknown> | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  const key = record.Key ?? record.Path;
  if (record.Name === undefined && key === undefined) return undefined;
  const stub: Record<string, unknown> = {};
  if (record.Name !== undefined) stub.Name = record.Name;
  if (key !== undefined) stub.Key = key;
  if (record.StorageId !== undefined) stub.StorageId = record.StorageId;
  stub.Abbreviated = ABBREVIATED_ITEM_NOTICE;
  return stub;
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
