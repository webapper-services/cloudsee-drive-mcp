import { z, type ZodRawShape } from "zod";
import type { CloudSeeClient } from "../client/CloudSeeClient";
import { CloudSeeError } from "../errors";

export interface ToolContext {
  client: CloudSeeClient;
  /** Optional configured default drive (CLOUDSEE_DEFAULT_BUCKET); never hardcoded. */
  defaultBucket?: string;
}

/** Reusable Zod field for the drive/bucket selector. Optional in the schema so a
 *  configured CLOUDSEE_DEFAULT_BUCKET can supply it; `resolveBucket` enforces presence. */
export const bucketField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The CloudSee drive (S3 bucket) name to operate in, e.g. 'max-2778abc0' — find it in the CloudSee dashboard. Required unless CLOUDSEE_DEFAULT_BUCKET is configured on the server.",
  );

/** Resolve the drive/bucket from the parsed tool input, falling back to the
 *  configured default. The value is always taken from input or config — never
 *  hardcoded — and an actionable error is thrown when neither is present. */
export function resolveBucket(bucket: string | undefined, defaultBucket: string | undefined): string {
  const resolved = (bucket ?? defaultBucket ?? "").trim();
  if (!resolved) {
    throw new CloudSeeError(
      "No CloudSee drive specified. Pass `bucketName` (your drive name, shown in the CloudSee dashboard), " +
        "or set CLOUDSEE_DEFAULT_BUCKET in the server config.",
      { code: "no_bucket" },
    );
  }
  return resolved;
}

export interface ToolResult {
  // Index signature mirrors the MCP SDK's CallToolResult (which permits extra
  // fields like _meta); lets ToolResult satisfy the registerTool callback type.
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** The real data-plane endpoint a tool wraps — asserted against the committed
 *  contract snapshot by the drift test. `path` excludes the `/v1` prefix. */
export interface ToolEndpoint {
  method: "POST";
  path: string;
  scopes: string[];
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  endpoint: ToolEndpoint;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
