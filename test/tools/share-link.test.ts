import { describe, it, expect, vi } from "vitest";
import { allTools } from "../../src/tools/index";
import type { CloudSeeClient } from "../../src/client/CloudSeeClient";

// CSD-662 F11. share_link used to be download_file with a boolean flipped: it posted to
// /storage/object/download-url and returned a raw S3 pre-signed URL — bucket name in the
// hostname, full path in the URL, fixed 24h, not revocable, no attribution. The product
// already publishes the right route (/shares/link/create, token-backed, revocable).

const shareLink = allTools.find((tool) => tool.name === "share_link")!;

// A value that appears nowhere else, so "the token did not leak" is decidable by substring.
const RAW_SHARE_TOKEN = "sentinel-raw-share-token-4f1c9ab27e0d-never-render-me";

const createShareLinkResponse = {
  shareableLink: "https://drive.cloudsee.cloud/share/2f9c1d7e-0f2a-4d61-9f6a-9b4c1f0d33aa",
  expiredTimeUTC: "2026-09-14T13:48:34.000Z",
  shareId: "2f9c1d7e-0f2a-4d61-9f6a-9b4c1f0d33aa",
  token: RAW_SHARE_TOKEN,
};

function fakeClient(post: ReturnType<typeof vi.fn>): CloudSeeClient {
  return { post, postPaged: vi.fn() } as unknown as CloudSeeClient;
}

function firstText(res: { content: Array<{ text?: string }> }): string {
  return res.content[0]?.text ?? "";
}

describe("share_link endpoint", () => {
  it("declares the token-backed share route with the scope the registry requires", () => {
    expect(shareLink.endpoint.method).toBe("POST");
    expect(shareLink.endpoint.path).toBe("/shares/link/create");
    expect(shareLink.endpoint.scopes).toEqual(["drive:write"]);
  });

  it("posts to /shares/link/create with an object-target body", async () => {
    const post = vi.fn().mockResolvedValue(createShareLinkResponse);
    await shareLink.handler(
      { bucketName: "cloudsee-demo", filePath: "MCP-Test-2026-09-13/csd586-metadata-test.txt", storageId: "os-1" },
      { client: fakeClient(post) },
    );

    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/shares/link/create");
    expect(body.targetType).toBe("object");
    expect(body.bucketName).toBe("cloudsee-demo");
    expect(body.filePath).toBe("MCP-Test-2026-09-13/csd586-metadata-test.txt");
    expect(body.storageId).toBe("os-1");
    // The pre-signed-URL vocabulary must not survive the repoint.
    expect(body).not.toHaveProperty("shareableLink");
    expect(body).not.toHaveProperty("download");
  });

  it("forwards expireTime only when the caller sets one, so the server applies its own default", async () => {
    const withExpiry = vi.fn().mockResolvedValue(createShareLinkResponse);
    await shareLink.handler(
      { bucketName: "cloudsee-demo", filePath: "docs/a.txt", expireTime: 48 },
      { client: fakeClient(withExpiry) },
    );
    const [, bodyWithExpiry] = withExpiry.mock.calls[0] as [string, Record<string, unknown>];
    expect(bodyWithExpiry.expireTime).toBe(48);

    const withoutExpiry = vi.fn().mockResolvedValue(createShareLinkResponse);
    await shareLink.handler(
      { bucketName: "cloudsee-demo", filePath: "docs/a.txt" },
      { client: fakeClient(withoutExpiry) },
    );
    const [, bodyWithoutExpiry] = withoutExpiry.mock.calls[0] as [string, Record<string, unknown>];
    expect(bodyWithoutExpiry).not.toHaveProperty("expireTime");
  });

  it("rejects a non-positive expireTime before calling the API", async () => {
    const post = vi.fn();
    await expect(
      shareLink.handler(
        { bucketName: "cloudsee-demo", filePath: "docs/a.txt", expireTime: 0 },
        { client: fakeClient(post) },
      ),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an empty filePath before calling the API", async () => {
    const post = vi.fn();
    await expect(
      shareLink.handler({ bucketName: "cloudsee-demo", filePath: "" }, { client: fakeClient(post) }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("share_link output", () => {
  it("renders the share page URL, its expiry and the share id", async () => {
    const post = vi.fn().mockResolvedValue(createShareLinkResponse);
    const res = await shareLink.handler(
      { bucketName: "cloudsee-demo", filePath: "docs/a.txt" },
      { client: fakeClient(post) },
    );

    const text = firstText(res as never);
    expect(text).toContain("shareableLink");
    expect(text).toContain(createShareLinkResponse.shareableLink);
    expect(text).toContain("expiredTimeUTC");
    expect(text).toContain(createShareLinkResponse.expiredTimeUTC);
    expect(text).toContain("shareId");
    expect(text).toContain(createShareLinkResponse.shareId);
    expect(text).not.toContain("s3.amazonaws.com");
  });

  it("never echoes the raw share token — it is a bearer secret returned exactly once", async () => {
    const post = vi.fn().mockResolvedValue(createShareLinkResponse);
    const res = await shareLink.handler(
      { bucketName: "cloudsee-demo", filePath: "docs/a.txt" },
      { client: fakeClient(post) },
    );

    const text = firstText(res as never);
    expect(text).not.toContain(RAW_SHARE_TOKEN);
    expect(text).not.toContain("token");
  });

  it("renders the projection without throwing when the endpoint answers with no body", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const res = await shareLink.handler(
      { bucketName: "cloudsee-demo", filePath: "docs/a.txt" },
      { client: fakeClient(post) },
    );
    expect(firstText(res as never)).not.toContain(RAW_SHARE_TOKEN);
  });
});
