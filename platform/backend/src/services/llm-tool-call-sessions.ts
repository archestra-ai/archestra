import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { withoutTrajectoryStamp } from "@/openappa/trajectory-stamp";

/**
 * Which LLM session made a tool call, for the MCP gateway that runs it.
 *
 * Claude Code names the model's `tool_use` id on each gateway call
 * (`_meta["claudecode/toolUseId"]`) but not its session, so without help the
 * gateway cannot log the call under its session or record which session
 * started a run. The proxy leaves the session here for each MCP tool call it
 * hands a client, keyed by organization and call id, and the gateway reads it
 * back when the request names no session. An entry answers only the user whose
 * request produced the call.
 */
class LlmToolCallSessions {
  async remember(params: {
    organizationId: string;
    userId: string | null | undefined;
    sessionId: string | null | undefined;
    toolCalls: readonly { id: string; name: string; namespace?: string }[];
  }): Promise<void> {
    const { organizationId, userId, sessionId } = params;
    if (!userId || !sessionId) return;
    const callIds = [
      ...new Set(
        params.toolCalls
          .filter(isClientMcpToolCall)
          .map((call) => withoutTrajectoryStamp(call.id)),
      ),
    ];
    if (callIds.length === 0) return;
    try {
      await Promise.all(
        callIds.map((callId) =>
          cacheManager.set<ToolCallSession>(
            toolCallSessionKey({ organizationId, callId }),
            { sessionId, userId },
            ENTRY_TTL_MS,
          ),
        ),
      );
    } catch (error) {
      // A lost entry only leaves that gateway call without its session.
      logger.warn(
        { err: error },
        "Could not record the LLM session of the response's tool calls",
      );
    }
  }

  async resolve(params: {
    organizationId: string;
    userId: string | undefined;
    toolCallId: string;
  }): Promise<string | undefined> {
    if (!params.userId) return undefined;
    const entry = await cacheManager.get<ToolCallSession>(
      toolCallSessionKey({
        organizationId: params.organizationId,
        callId: withoutTrajectoryStamp(params.toolCallId),
      }),
    );
    return entry?.userId === params.userId ? entry.sessionId : undefined;
  }
}

export const llmToolCallSessions = new LlmToolCallSessions();

// ===

type ToolCallSession = { sessionId: string; userId: string };

/** Long enough for a call the client holds for the user's permission. */
const ENTRY_TTL_MS = TimeInMs.Hour * 6;

/**
 * MCP tools as coding clients present them to the model: Claude Code names
 * them `mcp__<server>__<tool>`, Codex puts them in an `mcp__<server>`
 * namespace. Built-in client tools never reach the gateway.
 */
function isClientMcpToolCall(call: { name: string; namespace?: string }) {
  return (
    call.name.startsWith(MCP_TOOL_PREFIX) ||
    (call.namespace?.startsWith(MCP_TOOL_PREFIX) ?? false)
  );
}

const MCP_TOOL_PREFIX = "mcp__";

function toolCallSessionKey(params: {
  organizationId: string;
  callId: string;
}): AllowedCacheKey {
  // Hashed: call ids are client-shaped text and keys are capped at 255.
  const digest = createHash("sha256")
    .update(JSON.stringify([params.organizationId, params.callId]))
    .digest("base64url");
  return `${CacheKey.LlmToolCallSession}-${digest}`;
}
