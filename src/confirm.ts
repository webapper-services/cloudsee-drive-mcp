import { z } from "zod";
import { textResult, type ToolResult } from "./tools/types";

// Two-step confirmation for destructive tools. A first call WITHOUT confirm=true
// returns a human-readable preview and performs no mutation; the model (or user)
// must re-call with confirm=true to execute. This is UX, NOT the security
// boundary — the CloudSee API authorizes every operation server-side.

export const confirmShape = {
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Must be true to actually perform this mutating/irreversible action. If omitted or false, the tool returns a preview and makes no changes.",
    ),
};

const SECURITY_NOTE =
  "Note: this confirmation is a client-side safety prompt, not the security boundary — " +
  "the CloudSee API authorizes every operation server-side.";

/** The no-op preview returned when a destructive tool is called without confirm=true. */
export function confirmationPreview(action: string, details: string): ToolResult {
  return textResult(
    `⚠️ Confirmation required — no changes have been made.\n\n` +
      `About to: ${action}\n${details}\n\n` +
      `Re-run this tool with confirm=true to proceed.\n${SECURITY_NOTE}`,
  );
}
