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
