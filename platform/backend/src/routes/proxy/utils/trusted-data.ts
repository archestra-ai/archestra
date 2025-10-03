import { InteractionModel, TrustedDataPolicyModel } from "../../../models";
import type { ChatCompletionRequestMessages } from "../types";

/**
 * Extract tool name from conversation history by finding the assistant message
 * that contains the tool_call_id
 *
 * We need to do this because the name of the tool is not included in the "tool" message (ie. tool call result)
 * (just the content and tool_call_id)
 */
const extractToolNameFromHistory = async (
  chatId: string,
  toolCallId: string,
): Promise<string | null> => {
  const interactions = await InteractionModel.findByChatId(chatId);

  // Find the most recent assistant message with tool_calls
  for (let i = interactions.length - 1; i >= 0; i--) {
    const { content } = interactions[i];

    if (content.role === "assistant" && content.tool_calls) {
      for (const toolCall of content.tool_calls) {
        if (toolCall.id === toolCallId) {
          if (toolCall.type === "function") {
            return toolCall.function.name;
          } else {
            return toolCall.custom.name;
          }
        }
      }
    }
  }

  return null;
};

export const evaluatePolicies = async (
  messages: ChatCompletionRequestMessages,
  chatId: string,
) => {
  for (const message of messages) {
    if (message.role === "tool") {
      const { tool_call_id: toolCallId, content } = message;
      let toolResult: unknown;
      if (typeof content === "string") {
        try {
          toolResult = JSON.parse(content);
        } catch {
          // If content is not valid JSON, use it as-is
          toolResult = content;
        }
      } else {
        toolResult = content;
      }

      // Extract tool name from conversation history
      const toolName = await extractToolNameFromHistory(chatId, toolCallId);

      if (toolName) {
        // Evaluate trusted data policy
        const { isTrusted, isBlocked, reason } =
          await TrustedDataPolicyModel.evaluate(chatId, toolName, toolResult);

        // Store tool result as interaction
        await InteractionModel.create({
          chatId,
          content: message,
          trusted: isTrusted,
          blocked: isBlocked,
          reason,
        });
      }
    }
  }
};

/**
 * Filter out blocked tool results from the context
 *
 * This function removes tool response messages that have been marked as blocked
 * by trusted data policies, preventing the LLM from seeing potentially malicious data
 */
export const filterOutBlockedData = async (
  chatId: string,
  messages: ChatCompletionRequestMessages,
): Promise<ChatCompletionRequestMessages> => {
  // Get blocked tool call IDs from interactions
  const blockedToolCallIds =
    await InteractionModel.getBlockedToolCallIds(chatId);

  // If no blocked interactions, return messages as-is
  if (blockedToolCallIds.size === 0) {
    return messages;
  }

  // Filter out messages with blocked tool_call_ids
  return messages.filter((message) => {
    if (message.role === "tool" && message.tool_call_id) {
      return !blockedToolCallIds.has(message.tool_call_id);
    }
    return true;
  });
};
