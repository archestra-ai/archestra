import {
  extractMcpToolError,
  type LogContentMode,
  type LogContentNotStored,
  logContentNotStored,
  MCP_EXECUTED_AS_META_KEY,
  McpExecutedAsSchema,
} from "@archestra/shared";
import config from "@/config";
import type {
  InsertInteraction,
  InsertMcpToolCall,
  InteractionRequest,
  InteractionResponse,
} from "@/types";
import { InteractionErrorResponseSchema } from "@/types/interaction";

/**
 * The Log Content mode every log row is written under, set deployment-wide by
 * `ARCHESTRA_LOGS_CONTENT_MODE`. The single place the decision is made, so a
 * later per-agent or per-team override (which may only ever be stricter) has
 * one spot to land.
 */
export function resolveLogContentMode(): LogContentMode {
  return config.logs.contentMode;
}

/**
 * An LLM interaction with every content column replaced: the request and
 * response become the not-stored marker (which keeps whether the call failed,
 * never the error text), and the columns derived from content are dropped.
 * Usage, cost, model and attribution are untouched.
 */
export function withholdInteractionContent(
  record: InsertInteraction,
): InsertInteraction {
  return {
    ...record,
    request: logContentNotStored() as unknown as InteractionRequest,
    processedRequest: null,
    response: logContentNotStored({
      isError: InteractionErrorResponseSchema.safeParse(record.response)
        .success,
    }) as unknown as InteractionResponse,
    dualLlmAnalyses: null,
    unsafeContextBoundary: null,
  };
}

/**
 * An MCP log row with its arguments and result replaced by the not-stored
 * marker. The tool name stays: which tool ran is audit metadata, what it was
 * given and what it returned is content.
 */
export function withholdToolCallContent(
  record: InsertMcpToolCall,
): InsertMcpToolCall {
  return {
    ...record,
    // Rebuilt rather than spread so nothing but the identity survives; `kind`
    // is dropped because a custom call's arguments must hold its raw input.
    toolCall: record.toolCall
      ? {
          id: record.toolCall.id,
          name: record.toolCall.name,
          arguments: logContentNotStored(),
        }
      : null,
    toolResult:
      record.toolResult === null || record.toolResult === undefined
        ? record.toolResult
        : logContentNotStored(toolResultOutcome(record.toolResult)),
  };
}

// === Internal helpers ===

/**
 * What a Logs page needs to show a tool call's status and identity: whether
 * it failed, Archestra's category for the failure, and whose credential it ran
 * as. Error messages are left out because they routinely quote the arguments.
 */
function toolResultOutcome(
  result: unknown,
): Omit<LogContentNotStored, "__redacted"> {
  if (typeof result !== "object" || result === null) return {};
  const { isError, _meta } = result as {
    isError?: unknown;
    _meta?: Record<string, unknown>;
  };
  const errorType = extractMcpToolError(result)?.type;
  const executedAs = McpExecutedAsSchema.safeParse(
    _meta?.[MCP_EXECUTED_AS_META_KEY],
  );
  return {
    // Only tools/call results carry a status; discovery results have none.
    ...(typeof isError === "boolean" ? { isError } : {}),
    ...(errorType ? { errorType } : {}),
    ...(executedAs.success
      ? { [MCP_EXECUTED_AS_META_KEY]: executedAs.data }
      : {}),
  };
}
