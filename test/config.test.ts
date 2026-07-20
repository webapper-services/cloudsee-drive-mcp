import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_BASE_URL } from "../src/config";
import { CloudSeeError } from "../src/errors";

describe("loadConfig", () => {
  it("throws an actionable, secret-free error when required vars are missing", () => {
    const err = (() => {
      try {
        loadConfig({} as NodeJS.ProcessEnv);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(CloudSeeError);
    expect(err?.message).toContain("CLOUDSEE_API_KEY_ID");
    expect(err?.message).toContain("CLOUDSEE_API_KEY_SECRET");
  });

  it("loads valid config and defaults the base URL + timeout", () => {
    const cfg = loadConfig({
      CLOUDSEE_API_KEY_ID: "id",
      CLOUDSEE_API_KEY_SECRET: "sec",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiKeyId).toBe("id");
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.logLevel).toBe("info");
  });

  it("accepts a custom base URL and trims trailing slashes", () => {
    const cfg = loadConfig({
      CLOUDSEE_API_KEY_ID: "id",
      CLOUDSEE_API_KEY_SECRET: "sec",
      CLOUDSEE_API_BASE_URL: "https://drive-api-uat.cloudsee.cloud/",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toBe("https://drive-api-uat.cloudsee.cloud");
  });

  it("reads an optional default bucket from config (never hardcoded) and leaves it undefined otherwise", () => {
    const base = { CLOUDSEE_API_KEY_ID: "id", CLOUDSEE_API_KEY_SECRET: "sec" };
    expect(loadConfig(base as unknown as NodeJS.ProcessEnv).defaultBucket).toBeUndefined();
    const withBucket = loadConfig({
      ...base,
      CLOUDSEE_DEFAULT_BUCKET: "max-2778abc0",
    } as unknown as NodeJS.ProcessEnv);
    expect(withBucket.defaultBucket).toBe("max-2778abc0");
  });

  it("rejects an invalid base URL", () => {
    expect(() =>
      loadConfig({
        CLOUDSEE_API_KEY_ID: "id",
        CLOUDSEE_API_KEY_SECRET: "sec",
        CLOUDSEE_API_BASE_URL: "not-a-url",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(CloudSeeError);
  });
});
