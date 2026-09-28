import { z } from "zod";
import {
  MCP_EXECUTED_AS_META_KEY,
  McpExecutedAsSchema,
} from "./mcp-executed-as";
import { McpToolErrorTypeSchema } from "./mcp-tool-error";

/**
 * How much an organization's logs record about each LLM request, MCP tool call
 * and guardrail consult.
 *
 * - `full`: prompts, responses, tool arguments and results are stored and shown
 *   on the Logs pages.
 * - `metadata_only`: that content is never written. Who, when, which model or
 *   tool, token usage, cost and the outcome (success or error) still are, so
 *   usage accounting, cost limits and the audit trail keep working.
 */
export const LOG_CONTENT_MODES = ["full", "metadata_only"] as const;

export const LogContentModeSchema = z
  .enum(LOG_CONTENT_MODES)
  .meta({ id: "LogContentMode" });

export type LogContentMode = z.infer<typeof LogContentModeSchema>;

/**
 * The `__redacted` value written in place of content the Log Content setting
 * kept out of storage. It shares the `__redacted` key with the locked-chat
 * fallback because both mean the same thing to a reader — this content was
 * never stored and cannot be recovered — so every read path that already
 * recognizes that shape keeps working.
 */
export const LOG_CONTENT_POLICY_REDACTED_VALUE = "log_content_policy";

/**
 * The marker stored in place of withheld content. It keeps only the outcome a
 * Logs page shows as a status badge, never any text: an error message or tool
 * result can quote the content the setting withholds.
 */
export const LogContentNotStoredSchema = z.object({
  __redacted: z.literal(LOG_CONTENT_POLICY_REDACTED_VALUE),
  /** The LLM request or tool call failed. */
  isError: z.boolean().optional(),
  /** Archestra's own category for a failed tool call (e.g. `cancelled`). */
  errorType: McpToolErrorTypeSchema.optional(),
  /**
   * Which identity a tool call ran as — who, never what. Under the same key
   * `extractMcpExecutedAs` reads, so the "Called as" displays need no change.
   */
  [MCP_EXECUTED_AS_META_KEY]: McpExecutedAsSchema.optional(),
});

export type LogContentNotStored = z.infer<typeof LogContentNotStoredSchema>;

export function logContentNotStored(
  outcome: Omit<LogContentNotStored, "__redacted"> = {},
): LogContentNotStored {
  return { __redacted: LOG_CONTENT_POLICY_REDACTED_VALUE, ...outcome };
}

export function isLogContentNotStored(
  value: unknown,
): value is LogContentNotStored {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __redacted?: unknown }).__redacted ===
      LOG_CONTENT_POLICY_REDACTED_VALUE
  );
}
