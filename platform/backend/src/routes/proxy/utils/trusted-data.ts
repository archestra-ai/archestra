import { DualLlmResultModel, TrustedDataPolicyModel } from "@/models";
import type {
  CommonMessage,
  SupportedProvider,
  ToolResultUpdates,
} from "@/types";
import { DualLlmSubagent } from "./dual-llm-subagent";

/**
 * Evaluate if context is trusted and return updates for tool results
 *
 * @param messages - Messages in common format
 * @param agentId - The agent ID
 * @param apiKey - API key for the LLM provider
 * @param provider - The LLM provider
 * @param considerContextUntrusted - If true, marks context as untrusted from the beginning
 * @param onDualLlmStart - Optional callback when dual LLM processing starts
 * @param onDualLlmProgress - Optional callback for dual LLM Q&A progress
 * @returns Object with tool result updates and trust status
 */
export async function evaluateIfContextIsTrusted(
  messages: CommonMessage[],
  agentId: string,
  apiKey: string,
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
  const toolResultUpdates: ToolResultUpdates = {};
  let hasUntrustedData = false;
  let usedDualLlm = false;

  // If agent configured to consider context untrusted from the beginning,
  // mark context as untrusted immediately and skip evaluation
  if (considerContextUntrusted) {
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

  if (allToolCalls.length === 0) {
    return {
      toolResultUpdates,
      contextIsTrusted: true,
      usedDualLlm: false,
    };
  }

  // Bulk evaluate all tool calls for trusted data policies
  const evaluationResults = await TrustedDataPolicyModel.evaluateBulk(
    agentId,
    allToolCalls.map(({ toolName, toolResult }) => ({
      toolName,
      toolOutput: toolResult,
    })),
  );

  // Process evaluation results
  for (let i = 0; i < allToolCalls.length; i++) {
    const { toolCallId, toolResult } = allToolCalls[i];
    const evaluation = evaluationResults.get(i.toString());

    if (!evaluation) {
      // Tool not found - treat as untrusted
      hasUntrustedData = true;
      continue;
    }

    const { isTrusted, isBlocked, shouldSanitizeWithDualLlm, reason } =
      evaluation;

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
        // Notify that dual LLM processing is starting (only once)
        if (!usedDualLlm && onDualLlmStart) {
          onDualLlmStart();
        }

        // Run Dual LLM quarantine pattern
        usedDualLlm = true;

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
        const safeSummary =
          await dualLlmSubagent.processWithMainAgent(onDualLlmProgress);
        toolResultUpdates[toolCallId] = safeSummary;
      }

      // After sanitization, treat as trusted
      hasUntrustedData = false;
    }
    // If not blocked or sanitized, no update needed (original content remains)
  }

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
