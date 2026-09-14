import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CloudSeeClient } from "../../src/client/CloudSeeClient";
import { AuthError, CloudSeeError } from "../../src/errors";
import { configureLogger } from "../../src/logger";
import { allTools } from "../../src/tools/index";
import type { Config } from "../../src/config";

const config: Config = {
  apiKeyId: "AKIATEST",
  apiKeySecret: "super-secret-value",
  baseUrl: "https://drive-api.example.test",
  timeoutMs: 5000,
  logLevel: "error",
};

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("CloudSeeClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends auth headers + correct URL and unwraps the data envelope", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: 1 } }));
    const client = new CloudSeeClient(config);
    const data = await client.post("/storage/buckets", { a: 1 });
    expect(data).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://drive-api.example.test/v1/storage/buckets");
    expect(init.method).toBe("POST");
    // Gateway usage-plan key — required by /v1/{proxy+} (ApiKeyRequired); value is the ApiKeyId.
    // Without it the API Gateway rejects with 403 before the Lambda runs.
    expect(init.headers["X-Api-Key"]).toBe("AKIATEST");
    expect(init.headers["X-Api-Key-Id"]).toBe("AKIATEST");
    expect(init.headers["X-Api-Key-Secret"]).toBe("super-secret-value");
    expect(JSON.parse(init.body as string)).toEqual({ a: 1 });
  });

  it("throws AuthError on 401 without leaking the secret", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const client = new CloudSeeClient(config);
    await expect(client.post("/storage/buckets")).rejects.toBeInstanceOf(AuthError);
    const err = await client.post("/storage/buckets").catch((e) => e as Error);
    expect(err.message).not.toContain("super-secret-value");
  });

  it("surfaces an app-level 403 denial (insufficient_scope) instead of blaming the gateway", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: "insufficient_scope", message: "Missing required scope(s): drive:write." } },
        { status: 403 },
      ),
    );
    const client = new CloudSeeClient(config);
    const err = await client.post("/storage/folder/create").catch((e) => e as AuthError);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("insufficient_scope");
    expect(err.message).toContain("Missing required scope(s): drive:write.");
    expect(err.message).not.toContain("API gateway");
  });

  it("keeps the gateway wording for a bare gateway 403 (no app payload)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Forbidden" }, { status: 403 }));
    const client = new CloudSeeClient(config);
    const err = await client.post("/storage/folder/create").catch((e) => e as AuthError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("API gateway");
  });

  it("redacts the secret from an app-level denial message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "forbidden", message: "denied for super-secret-value" } }, { status: 403 }),
    );
    const client = new CloudSeeClient(config);
    const err = await client.post("/storage/folder/create").catch((e) => e as Error);
    expect(err.message).not.toContain("super-secret-value");
    expect(err.message).toContain("***");
  });

  it("surfaces success:false as a CloudSeeError carrying the code", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, errorMessage: "denied", code: "REVOKED" }));
    const client = new CloudSeeClient(config);
    await expect(client.post("/storage/list")).rejects.toMatchObject({ code: "REVOKED" });
  });

  it("retries on 429 honoring Retry-After, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: true } }));
    const client = new CloudSeeClient(config);
    const data = await client.post("/storage/recent", {}, { retries: 2 });
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on persistent 5xx", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const client = new CloudSeeClient(config);
    await expect(client.post("/storage/recent", {}, { retries: 1 })).rejects.toBeInstanceOf(CloudSeeError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial attempt + 1 retry
  });

  it("normalizes pagination into an opaque cursor via postPaged", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { items: [1, 2], nextPage: "PAGE2" } }));
    const client = new CloudSeeClient(config);
    const { nextCursor } = await client.postPaged("/storage/list", {}, "nextPage");
    expect(nextCursor).toBeTruthy();
    expect(nextCursor).not.toContain("PAGE2"); // opaque, not the raw token
  });

  it("extracts an envelope-level continuation token (sibling of data), not only one inside data", async () => {
    // Regression: /storage/recent returns `nextToken` as a sibling of `data`; the
    // client used to unwrap to `data` before looking for the token, dropping it.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [{ id: 1 }], nextToken: { StorageId: { N: "123" } }, total: 1 }),
    );
    const client = new CloudSeeClient(config);
    const { data, nextCursor } = await client.postPaged<unknown[]>("/storage/recent", { limit: 1 }, "nextToken");
    expect(data).toEqual([{ id: 1 }]);
    expect(nextCursor).toBeTruthy();
    expect(nextCursor).not.toContain("StorageId"); // opaque cursor, not the raw token
  });

  // CSD-662 F3a/F3b: the round trip, end to end over the wire. Page 1 hands back an array
  // token; the second request must carry it back as an array or OpenSearch 400s on
  // `search_after` and the caller gets the generic APP_ERROR sentence.
  it("puts a structured continuation token back on the wire in its original array shape", async () => {
    const searchAfter = [1757768351000, "Birds/", "abc"];
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { items: [{ Name: "Abubilla.jpg" }], totalItems: 21, nextPage: searchAfter } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { items: [{ Name: "Bluejay.webp" }], totalItems: 21, nextPage: null } }),
      );
    const client = new CloudSeeClient(config);

    const { nextCursor } = await client.postPaged("/storage/list", { bucketName: "cloudsee-demo", pageSize: 2 }, "nextPage");
    expect(nextCursor).toBeTruthy();
    await client.postPaged("/storage/list", { bucketName: "cloudsee-demo", pageSize: 2 }, "nextPage", nextCursor);

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Array.isArray(body.nextPage)).toBe(true);
    expect(body.nextPage).toEqual(searchAfter);
  });

  // CSD-662 F3c: /storage/recent WRITES its token as `nextToken` but READS it as `nextPage`
  // (app.js:406, and the published registry row). Sending it back under `nextToken` left
  // ExclusiveStartKey undefined — page 1 forever, with the identical cursor.
  it("sends recent_files' continuation token under `nextPage`, the field the endpoint reads", async () => {
    const lastEvaluatedKey = { StorageId: "937896d1", Email: "demoadmin@cloudsee.cloud" };
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: [{ Name: "a.txt" }, { Name: "b.txt" }], nextToken: lastEvaluatedKey }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ Name: "c.txt" }] }));
    const client = new CloudSeeClient(config);
    const recentFiles = allTools.find((tool) => tool.name === "recent_files");
    if (!recentFiles) throw new Error("recent_files tool is not registered");

    const firstPage = await recentFiles.handler({ limit: 2 }, { client });
    const cursor = /cursor="([^"]+)"/.exec(firstPage.content[0]?.text ?? "")?.[1];
    expect(cursor).toBeTruthy();
    await recentFiles.handler({ limit: 2, cursor }, { client });

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toHaveProperty("nextPage");
    expect(body).not.toHaveProperty("nextToken");
    expect(body.nextPage).toEqual(lastEvaluatedKey);
  });

  it("logs the request and response at debug level for API auditing (secret never shown)", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    try {
      configureLogger({ level: "debug", redact: [config.apiKeySecret] });
      fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: 1 } }));
      await new CloudSeeClient(config).post("/storage/buckets", { drive: "max-2778abc0" });
      const out = writes.join("");
      expect(out).toContain("→ POST"); // request logged
      expect(out).toContain("/v1/storage/buckets");
      expect(out).toContain('{"drive":"max-2778abc0"}'); // request body
      expect(out).toContain("← 200"); // response logged
      expect(out).not.toContain(config.apiKeySecret); // secret never appears in the audit log
    } finally {
      configureLogger({ level: "error" });
      spy.mockRestore();
    }
  });
});
