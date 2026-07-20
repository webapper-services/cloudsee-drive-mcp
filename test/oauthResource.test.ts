import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decodeAccessToken } from "../src/oauthResource";
import { CloudSeeClient } from "../src/client/CloudSeeClient";
import type { Config } from "../src/config";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Hand-built JWT (decodeAccessToken reads the payload segment, doesn't verify).
const fakeJwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.signature`;

describe("decodeAccessToken", () => {
  it("reads the ApiKeyId (kid) from a signed JWT and forwards the JWT as the bearer token", () => {
    const tok = fakeJwt({ typ: "oauth-access", kid: "AKIASIGNED", sub: "u@e.com", scp: ["drive:read"] });
    const r = decodeAccessToken(tok);
    expect(r.apiKeyId).toBe("AKIASIGNED");
    expect(r.bearerToken).toBe(tok);
    expect(r.secret).toBeUndefined();
  });

  it("falls back to a legacy base64url(id:secret) token", () => {
    const legacy = Buffer.from("AKIALEGACY:s3cr3t").toString("base64url");
    const r = decodeAccessToken(legacy);
    expect(r.apiKeyId).toBe("AKIALEGACY");
    expect(r.secret).toBe("s3cr3t");
    expect(r.bearerToken).toBeUndefined();
  });
});

describe("CloudSeeClient auth modes", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  const base: Config = { apiKeyId: "AKIABEARER", baseUrl: "https://api.test", timeoutMs: 5000, logLevel: "error" };

  it("signed-token mode sends X-Api-Key + Authorization: Bearer and NO secret headers", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const client = new CloudSeeClient({ ...base, bearerToken: "signed.jwt.token" });
    await client.post("/storage/buckets", {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers["X-Api-Key"]).toBe("AKIABEARER");
    expect(init.headers["Authorization"]).toBe("Bearer signed.jwt.token");
    expect(init.headers["X-Api-Key-Secret"]).toBeUndefined();
    expect(init.headers["X-Api-Key-Id"]).toBeUndefined();
  });

  it("id+secret mode sends the X-Api-Key-Id/Secret pair and no Authorization", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const client = new CloudSeeClient({ ...base, apiKeySecret: "sekret" });
    await client.post("/storage/buckets", {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers["X-Api-Key"]).toBe("AKIABEARER");
    expect(init.headers["X-Api-Key-Id"]).toBe("AKIABEARER");
    expect(init.headers["X-Api-Key-Secret"]).toBe("sekret");
    expect(init.headers["Authorization"]).toBeUndefined();
  });
});
