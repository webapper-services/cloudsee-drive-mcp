import { describe, it, expect, vi, afterEach } from "vitest";
import { configureLogger, logger, redactSecrets } from "../src/logger";

describe("logger", () => {
  afterEach(() => configureLogger({ level: "info", redact: [] }));

  it("writes to stderr and never to stdout (stdout is the MCP transport)", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const outWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    configureLogger({ level: "info" });
    logger.info("hello world");
    expect(errWrite).toHaveBeenCalled();
    expect(outWrite).not.toHaveBeenCalled();
    errWrite.mockRestore();
    outWrite.mockRestore();
  });

  it("redacts registered secrets anywhere they appear", () => {
    configureLogger({ redact: ["topsecret"] });
    expect(redactSecrets("authorization=topsecret done")).toBe("authorization=*** done");
  });

  it("respects the configured log level", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    configureLogger({ level: "warn" });
    logger.debug("should be suppressed");
    expect(errWrite).not.toHaveBeenCalled();
    logger.error("should appear");
    expect(errWrite).toHaveBeenCalledOnce();
    errWrite.mockRestore();
  });
});
