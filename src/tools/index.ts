import type { ToolDef } from "./types";
import { readTools } from "./read";
import { downloadTools } from "./download";
import { writeTools } from "./write";

/** The complete, grounded tool set. All tools are callable
 *  end-to-end; write/delete tools require the matching scope on the API key
 *  (the gateway RBAC is live). */
export const allTools: ToolDef[] = [...readTools, ...downloadTools, ...writeTools];

export type { ToolDef } from "./types";
