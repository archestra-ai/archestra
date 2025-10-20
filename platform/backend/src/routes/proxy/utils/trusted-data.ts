import { DualLlmResultModel, TrustedDataPolicyModel } from "@/models";
import { DualLlmSubagent } from "./dual-llm-subagent";
import type {
  CommonMessage,
  SupportedProviders,
  ToolResultUpdates,
} from "./types";

/**
 * Evaluate if context is trusted and return updates for tool results
 *
 * @param messages - Messages in common format
 * @param agentId - The agent ID
 * @param apiKey - API key for the LLM provider
 * @returns Object with tool result updates and trust status
 */
export async function evaluateIfContextIsTrusted(
  messages: CommonMessage[],
  agentId: string,
  apiKey: string,
  provider: SupportedProviders,
): Promise<{
  toolResultUpdates: ToolResultUpdates;
  contextIsTrusted: boolean;
}> {
  const toolResultUpdates: ToolResultUpdates = {};
  let hasUntrustedData = false;

  // Process each message looking for tool calls
  for (const message of messages) {
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        const { id: toolCallId, name: toolName, result: toolResult } = toolCall;

        // Evaluate trusted data policy
        const { isTrusted, isBlocked, shouldSanitizeWithDualLlm, reason } =
          await TrustedDataPolicyModel.evaluate(agentId, toolName, toolResult);

        if (!isTrusted) {
          hasUntrustedData = true;
        }

        if (isBlocked) {
          // Tool result is blocked - replace with blocked message
          toolResultUpdates[toolCallId] =
            `[Content blocked by policy${reason ? `: ${reason}` : ""}]`;
        } else if (shouldSanitizeWithDualLlm) {
          // Check if this tool call has already been analyzed
          const existingResult =
            await DualLlmResultModel.findByToolCallId(toolCallId);

          if (existingResult) {
            // Use cached result from database
            toolResultUpdates[toolCallId] = existingResult.result;
          } else {
            // Run Dual LLM quarantine pattern
            // Extract user request from messages (last user message)
            const userRequest = extractUserRequest(messages);

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
            const safeSummary = await dualLlmSubagent.processWithMainAgent();
            toolResultUpdates[toolCallId] = safeSummary;
          }

          // After sanitization, treat as trusted
          hasUntrustedData = false;
        }
        // If not blocked or sanitized, no update needed (original content remains)
      }
    }
  }

  return {
    toolResultUpdates,
    contextIsTrusted: !hasUntrustedData,
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
