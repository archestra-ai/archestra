import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import logger from "@/logging";

// Providers reject a history in which an assistant `tool_use` block is not
// answered by a `tool_result` in the message that immediately follows — and
// once such a turn is persisted, every subsequent request in the conversation
// fails the same way. Histories can legitimately contain unanswered calls:
// a tool part parked in `approval-requested` (the user sent a new message
// instead of resolving the approval, or the run was blocked in an autonomous
// session) converts to a tool-call with no result, and provider mappers
// silently drop the SDK's approval bookkeeping parts. Synthesize an
// "interrupted" result for those so the replay stays valid for any provider.
// A call the user just approved/declined (`approval-responded`) is deliberately
// left result-less: the SDK's own approval-resume executes or denies it on this
// request, and a synthetic result would pre-empt that (see the filter below).
const INTERRUPTED_TOOL_RESULT_TEXT =
  "Tool execution was interrupted before a result was recorded. It may have run partially or completely; do not assume success or retry side effects without checking.";

export function ensureToolCallsHaveResults(
  messages: ModelMessage[],
): ModelMessage[] {
  const repaired: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    repaired.push(message);

    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    // Results can live inline in the assistant content (provider-executed
    // tools) or in the immediately-following tool message.
    const next = messages[i + 1];
    const followingToolMessage =
      next?.role === "tool" && Array.isArray(next.content) ? next : null;
    const answeredToolCallIds = new Set(
      [...message.content, ...(followingToolMessage?.content ?? [])]
        .filter((part) => part.type === "tool-result")
        .map((part) => part.toolCallId),
    );

    // A tool call whose approval the user just answered is resolved by the AI
    // SDK's own approval-resume on this request: `collectToolApprovals` executes
    // an approved call (and denies a declined one) as long as no tool-result
    // exists for the call yet. Synthesizing an "interrupted" result here would
    // add exactly that result, so the SDK skips the call and the approved tool
    // silently never runs. Treat a call with a matching tool-approval-response
    // as already handled and leave it result-less for the SDK to resolve.
    const approvalRequestToolCallIds = new Map<string, string>();
    for (const part of message.content) {
      if (part.type === "tool-approval-request") {
        approvalRequestToolCallIds.set(part.approvalId, part.toolCallId);
      }
    }
    const approvalRespondedToolCallIds = new Set(
      (followingToolMessage?.content ?? [])
        .filter((part) => part.type === "tool-approval-response")
        .map((part) => approvalRequestToolCallIds.get(part.approvalId))
        .filter((toolCallId): toolCallId is string => toolCallId != null),
    );

    const unansweredToolCalls = message.content.filter(
      (part): part is ToolCallPart =>
        part.type === "tool-call" &&
        part.providerExecuted !== true &&
        !answeredToolCallIds.has(part.toolCallId) &&
        !approvalRespondedToolCallIds.has(part.toolCallId),
    );
    if (unansweredToolCalls.length === 0) {
      continue;
    }

    logger.warn(
      {
        toolCallIds: unansweredToolCalls.map((part) => part.toolCallId),
        toolNames: unansweredToolCalls.map((part) => part.toolName),
      },
      "[ensureToolCallsHaveResults] Synthesized interrupted tool results for unanswered tool calls",
    );

    const syntheticResults: ToolResultPart[] = unansweredToolCalls.map(
      (part) => ({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: { type: "error-text", value: INTERRUPTED_TOOL_RESULT_TEXT },
      }),
    );

    if (followingToolMessage) {
      repaired.push({
        ...followingToolMessage,
        content: [...followingToolMessage.content, ...syntheticResults],
      });
      i++; // the merged copy replaces the original tool message
    } else {
      repaired.push({ role: "tool", content: syntheticResults });
    }
  }

  return repaired;
}
