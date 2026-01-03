import type { SupportedProvider } from "@shared";
import logger from "@/logging";
import { DualLlmResultModel, TrustedDataPolicyModel } from "@/models";
import type { CommonMessage, ToolResultUpdates } from "@/types";
import { DualLlmSubagent } from "./dual-llm-subagent";

/**
 * Evaluate if context is trusted and return updates for tool results
 *
 * @param messages - Messages in common format
 * @param agentId - The agent ID
 * @param apiKey - API key for the LLM provider (optional for Gemini with Vertex AI)
 * @param provider - The LLM provider
 * @param considerContextUntrusted - If true, marks context as untrusted from the beginning
 * @param onDualLlmStart - Optional callback when dual LLM processing starts
 * @param onDualLlmProgress - Optional callback for dual LLM Q&A progress
 * @returns Object with tool result updates and trust status
 */
export async function evaluateIfContextIsTrusted(
  messages: CommonMessage[],
  agentId: string,
  apiKey: string | undefined,
  provider: SupportedProvider,
  considerContextUntrusted: boolean = false,
  onDualLlmStart?: () => void,
  onDualLlmProgress?: (progress: {
    question: string;
    options: string[];
    answer: string;
  }) => void,
): Promise<{
  toolResultUpdates: ToolResultUpdates;
  contextIsTrusted: boolean;
  usedDualLlm: boolean;
}> {
  logger.debug(
    {
      agentId,
      messageCount: messages.length,
      provider,
      considerContextUntrusted,
    },
    "[trustedData] evaluateIfContextIsTrusted: starting evaluation",
  );

  const toolResultUpdates: ToolResultUpdates = {};
  let hasUntrustedData = false;
  let usedDualLlm = false;

  // If agent configured to consider context untrusted from the beginning,
  // mark context as untrusted immediately and skip evaluation
  if (considerContextUntrusted) {
    logger.debug(
      { agentId },
      "[trustedData] evaluateIfContextIsTrusted: context marked untrusted by agent config",
    );
    return {
      toolResultUpdates: {},
      contextIsTrusted: false,
      usedDualLlm: false,
    };
  }

  // First, collect all tool calls from all messages
  const allToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
    toolResult: any;
  }> = [];

  for (const message of messages) {
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        allToolCalls.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          toolResult: toolCall.content,
        });
      }
    }
  }

  logger.debug(
    { agentId, toolCallCount: allToolCalls.length },
    "[trustedData] evaluateIfContextIsTrusted: collected tool calls from messages",
  );

  if (allToolCalls.length === 0) {
    logger.debug(
      { agentId },
      "[trustedData] evaluateIfContextIsTrusted: no tool calls found, context is trusted",
    );
    return {
      toolResultUpdates,
      contextIsTrusted: true,
      usedDualLlm: false,
    };
  }

  // Bulk evaluate all tool calls for trusted data policies
  logger.debug(
    { agentId, toolCallCount: allToolCalls.length },
    "[trustedData] evaluateIfContextIsTrusted: bulk evaluating trusted data policies",
  );
  const evaluationResults = await TrustedDataPolicyModel.evaluateBulk(
    agentId,
    allToolCalls.map(({ toolName, toolResult }) => ({
      toolName,
      toolOutput: toolResult,
    })),
  );

  logger.debug(
    { agentId, evaluationResultCount: evaluationResults.size },
    "[trustedData] evaluateIfContextIsTrusted: evaluation results received",
  );

  // Process evaluation results
  for (let i = 0; i < allToolCalls.length; i++) {
    const { toolCallId, toolResult, toolName } = allToolCalls[i];
    const evaluation = evaluationResults.get(i.toString());

    if (!evaluation) {
      // Tool not found - treat as untrusted
      logger.debug(
        { agentId, toolCallId, toolName },
        "[trustedData] evaluateIfContextIsTrusted: no evaluation result, treating as untrusted",
      );
      hasUntrustedData = true;
      continue;
    }

    const { isTrusted, isBlocked, shouldSanitizeWithDualLlm, reason } =
      evaluation;
    logger.debug(
      {
        agentId,
        toolCallId,
        toolName,
        isTrusted,
        isBlocked,
        shouldSanitizeWithDualLlm,
      },
      "[trustedData] evaluateIfContextIsTrusted: tool evaluation result",
    );

    if (!isTrusted) {
      hasUntrustedData = true;
    }

    if (isBlocked) {
      // Tool result is blocked - replace with blocked message
      logger.debug(
        { agentId, toolCallId, reason },
        "[trustedData] evaluateIfContextIsTrusted: tool result blocked by policy",
      );
      toolResultUpdates[toolCallId] =
        `[Content blocked by policy${reason ? `: ${reason}` : ""}]`;
    } else if (shouldSanitizeWithDualLlm) {
      // Check if this tool call has already been analyzed
      logger.debug(
        { agentId, toolCallId },
        "[trustedData] evaluateIfContextIsTrusted: checking for cached dual LLM result",
      );
      const existingResult =
        await DualLlmResultModel.findByToolCallId(toolCallId);

      if (existingResult) {
        // Use cached result from database
        logger.debug(
          { agentId, toolCallId },
          "[trustedData] evaluateIfContextIsTrusted: using cached dual LLM result",
        );
        toolResultUpdates[toolCallId] = existingResult.result;
      } else {
        // Notify that dual LLM processing is starting (only once)
        if (!usedDualLlm && onDualLlmStart) {
          logger.debug(
            { agentId, toolCallId },
            "[trustedData] evaluateIfContextIsTrusted: starting dual LLM processing",
          );
          onDualLlmStart();
        }

        // Run Dual LLM quarantine pattern
        usedDualLlm = true;

        // Extract user request from messages (last user message)
        const userRequest = extractUserRequest(messages);

        logger.debug(
          { agentId, toolCallId, provider },
          "[trustedData] evaluateIfContextIsTrusted: creating dual LLM subagent",
        );
        const dualLlmSubagent = await DualLlmSubagent.create(
          {
            toolCallId,
            userRequest,
            toolResult,
          },
          agentId,
          apiKey,
          provider,
        );

        // Get safe summary and store as update
        logger.debug(
          { agentId, toolCallId },
          "[trustedData] evaluateIfContextIsTrusted: processing with dual LLM subagent",
        );
        const safeSummary =
          await dualLlmSubagent.processWithMainAgent(onDualLlmProgress);
        toolResultUpdates[toolCallId] = safeSummary;
        logger.debug(
          { agentId, toolCallId, summaryLength: safeSummary.length },
          "[trustedData] evaluateIfContextIsTrusted: dual LLM processing complete",
        );
      }

      // After sanitization, treat as trusted
      hasUntrustedData = false;
    }
    // If not blocked or sanitized, no update needed (original content remains)
  }

  logger.debug(
    {
      agentId,
      updateCount: Object.keys(toolResultUpdates).length,
      contextIsTrusted: !hasUntrustedData,
      usedDualLlm,
    },
    "[trustedData] evaluateIfContextIsTrusted: evaluation complete",
  );

  return {
    toolResultUpdates,
    contextIsTrusted: !hasUntrustedData,
    usedDualLlm,
  };
}

/**
 * Extract the user's original request from messages
 * Looks for the last user message that contains actual content
 */
function extractUserRequest(messages: CommonMessage[]): string {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      // For now, we return a generic request
      // The adapters can provide more specific extraction if needed
      return "process this data";
    }
  }
  return "process this data";
}
